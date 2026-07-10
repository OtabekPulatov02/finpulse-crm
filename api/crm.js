/* ============================================================
   Finpulse CRM — API-мост между веб-CRM и Telegram-ботом.
   Читает те же ключи Upstash Redis, что и api/bot.js.

   GET  /api/crm?r=ping     → проверка связи (кол-во задач, группа)
   GET  /api/crm?r=tasks    → последние задачи из бота (без личных данных)
   GET  /api/crm?r=logs&src=telegram|crm → журнал событий
   GET  /api/crm?r=pending  → компании из бота, ждущие активации
   GET  /api/crm?r=clients  → список клиентов (реальная БД, client:<id>)
   GET  /api/crm?r=client&id=<id> → карточка клиента
   POST /api/crm {action:"status", num, status, assignee}
        → смена статуса: Redis + карточка в группе + уведомление клиента
   POST /api/crm {action:"client_update", id, patch:{...}}
        → редактирование карточки клиента (только staff)
   POST /api/crm {action:"client_create", company, phone, position, ...}
        → создание клиента вручную из CRM, с той же дедупликацией по
          телефону/названию компании, что и при онбординге в боте
   POST /api/crm {action:"task_create", clientId?, company?, text, assignee?, dueDate?}
        → создание задачи из CRM: карточка в группу + уведомление клиенту
          в его телеграме (если clientId привязан к telegramId)
   POST /api/crm {action:"task_update", num, patch:{text?, assignee?, company?, dueDate?}}
        → редактирование полей задачи, включая срок (dueDate, "YYYY-MM-DD")
   POST /api/crm {action:"client_delete", id} → удаление клиента (только admin)
   POST /api/crm {action:"task_delete", num} → удаление задачи (только admin)
   GET  /api/crm?r=calendar → задачи со сроком (dueDate), не выполненные,
        с флагами overdue/dueToday — источник для напоминаний Vercel Cron
        (см. api/cron/reminders.js) и календаря на фронте
   GET  /api/crm?r=employees → список сотрудников (только admin)
   POST /api/crm {action:"employee_create", name, phone, role}
        → создание сотрудника: логин — телефон, пароль генерируется и
          возвращается один раз в ответе (только admin)
   POST /api/crm {action:"employee_update", id, patch:{name?, role?, active?}}
   POST /api/crm {action:"employee_reset_password", id} → новый пароль (один раз в ответе)
   POST /api/crm {action:"employee_delete", id}
   GET  /api/crm?r=calendar_events → повторяющиеся события календаря
        (налоги/платежи), отдельно от дедлайнов задач — см. calendarevent:<id>
   POST /api/crm {action:"calendar_event_create", type:"tax"|"pay", title,
        company?, date:"YYYY-MM-DD", repeat?:"once"|"monthly"|"quarterly"|"yearly",
        remindDays?:0|1|3|7}
   POST /api/crm {action:"calendar_event_update", id, patch:{...}}
   POST /api/crm {action:"calendar_event_delete", id} → только admin
   ============================================================ */

const { Redis } = require("@upstash/redis");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

/* Расставляет пробелы-разделители тысяч в суммах внутри произвольного
   текста ("1000000" -> "1 000 000") — в названиях/описаниях задач,
   заголовках напоминаний и т.п. Идемпотентно (повторный вызов на уже
   отформатированной строке ничего не меняет), поэтому применяется прямо
   при сохранении текста, а не отдельно в каждом месте отображения. */
function formatSumsInText(text) {
  return String(text ?? "").replace(/(?<![+№\d])\d{6,12}(?!\d)/g, (m) =>
    m.replace(/\B(?=(\d{3})+(?!\d))/g, " ")
  );
}

/* --- Доступ ---------------------------------------------------------
   Временная защита (до полноценных JWT-сессий из ролевой системы):
   - CRM_API_KEY: общий секрет, который CRM-фронт шлёт в заголовке x-api-key
   - CRM_ALLOWED_ORIGINS: список разрешённых Origin через запятую
   ---------------------------------------------------------------------- */
const API_KEY = process.env.CRM_API_KEY || "";
const ALLOWED_ORIGINS = (process.env.CRM_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function resolveOrigin(req) {
  const origin = req.headers.origin || "";
  if (!ALLOWED_ORIGINS.length) return origin || "*"; // список ещё не настроен — не ломаем текущую работу
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

function checkApiKey(req) {
  if (!API_KEY) return true; // ключ ещё не задан в env — пропускаем (переходный период)
  const provided = req.headers["x-api-key"];
  return provided === API_KEY;
}

/* --- Роли (JWT из /api/auth) -----------------------------------------
   Пока JWT_SECRET не задан в env — работаем как раньше (без ролей,
   полный доступ), чтобы не сломать текущий дашборд при раскатке.
   Как только JWT_SECRET настроен — GET/POST требуют валидный токен,
   и данные скоупятся по роли (client видит только свою компанию,
   guest получает демо-данные, оба не видят логи/pending и не могут
   менять статус). ------------------------------------------------------- */
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "";

function getAuthUser(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m || !JWT_SECRET) return null;
  try { return jwt.verify(m[1], JWT_SECRET); } catch { return null; }
}

const DEMO_TASKS = [
  { num: 9001, company: "Демо ООО «Пример»", text: "Подготовить отчёт по НДС", status: "in_progress", assignee: "Демо-бухгалтер", createdAt: new Date().toISOString(), files: 1, attachments: [{ index: 0, kind: "document" }] },
  { num: 9002, company: "Демо ООО «Пример»", text: "Свериться с поставщиком", status: "new", assignee: null, createdAt: new Date().toISOString(), files: 0, attachments: [] },
  { num: 9003, company: "Демо ООО «Пример»", text: "Начислить зарплату за месяц", status: "done", assignee: "Демо-бухгалтер", createdAt: new Date().toISOString(), files: 2, attachments: [{ index: 0, kind: "document" }, { index: 1, kind: "photo" }] },
];
const DEMO_EMPLOYEES = [
  { id: "demo-emp-1", name: "Демо-бухгалтер", phone: null, login: "demo", role: "accountant", active: true, createdAt: new Date().toISOString() },
];
const tg = (method, payload) =>
  fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => r.json()).catch(() => null);

/* Когда обычную группу апгрейдят до супергруппы, её chat_id меняется —
   старый id, сохранённый в redis "group", перестаёт работать, и Telegram
   отвечает ошибкой "group chat was upgraded to a supergroup chat" с
   правильным новым id в parameters.migrate_to_chat_id. Раньше эта ошибка
   просто проглатывалась (try/catch «карточка не критична»), поэтому
   новые задачи из CRM переставали появляться в группе после апгрейда, а
   прикрепление файлов падало с этой самой ошибкой. Эта обёртка сама
   обновляет сохранённый id и повторяет запрос один раз. */
async function tgToGroup(method, payload) {
  let group = await redis.get("group");
  if (!group) return { ok: false, error: "no group" };
  let resp = await tg(method, { chat_id: Number(group), ...payload });
  const migrated = resp && !resp.ok && resp.parameters && resp.parameters.migrate_to_chat_id;
  if (migrated) {
    group = resp.parameters.migrate_to_chat_id;
    await redis.set("group", group);
    resp = await tg(method, { chat_id: Number(group), ...payload });
  }
  return resp;
}

const MSG = {
  ru: {
    assigned: (n, name) => `👩‍💼 По задаче №${n} назначен бухгалтер: ${name}. Уже в работе!`,
    done: (n) => `✅ Задача №${n} выполнена. Если что-то ещё — просто напишите 👇`,
    reopened: (n) => `🔄 Задача №${n} возвращена в работу.`,
  },
  uz: {
    assigned: (n, name) => `👩‍💼 №${n} vazifaga buxgalter tayinlandi: ${name}. Ishga tushdi!`,
    done: (n) => `✅ №${n} vazifa bajarildi. Yana savol bo'lsa — yozing 👇`,
    reopened: (n) => `🔄 №${n} vazifa qayta ishga qaytarildi.`,
  },
  en: {
    assigned: (n, name) => `👩‍💼 Task #${n} was assigned to accountant: ${name}. Work has started!`,
    done: (n) => `✅ Task #${n} is done. Anything else — just write 👇`,
    reopened: (n) => `🔄 Task #${n} was reopened.`,
  },
};

MSG.ru.createdByCrm = (n, text) => `🆕 Бухгалтерия завела для вас задачу №${n}:\n\n${text}\n\nМы уже работаем над ней.`;
MSG.uz.createdByCrm = (n, text) => `🆕 Buxgalteriya siz uchun №${n} vazifa yaratdi:\n\n${text}\n\nBiz allaqachon ishlayapmiz.`;
MSG.en.createdByCrm = (n, text) => `🆕 Accounting created task #${n} for you:\n\n${text}\n\nWe're already working on it.`;

const STATUS_LINE = {
  new: "⚪️ Статус: Новая",
  in_progress: "🔵 Статус: В работе",
  done: "🟢 Статус: Выполнена",
};

async function logEvent(source, event, data) {
  try {
    await redis.lpush("logs:" + source, JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
    await redis.ltrim("logs:" + source, 0, 499);
  } catch (e) { /* noop */ }
}

function safeTask(t) {
  if (!t) return null;
  return {
    num: t.num,
    company: t.company,
    text: t.text,
    status: t.status,
    assignee: t.assignee || null,
    createdAt: t.createdAt || null,
    files: Array.isArray(t.files) ? t.files.length : 0,
    /* Метаданные вложений (без file_id — он остаётся на сервере, чтобы не
       светить его в браузере; сами байты отдаются через r=task_file). */
    attachments: Array.isArray(t.files) ? t.files.map((f, i) => ({ index: i, kind: f.kind || "document" })) : [],
    dueDate: t.dueDate || null,
    source: t.source === "crm" ? "crm" : "bot",
    doneAt: t.doneAt || null,
  };
}

function maskPhone(p) {
  if (!p) return null;
  return String(p).replace(/(\+?\d{3})\d+(\d{2})$/, "$1 *** ** $2");
}

/* --- Клиенты (реальная сущность client:<id>, та же дедупликация,
   что и в онбординге бота: индексы по телефону и нормализованному
   названию компании). Логика намеренно продублирована из api/bot.js
   (а не вынесена в общий модуль) — так безопаснее раскатывать без
   риска сломать уже проверенный флоу бота. --------------------------- */
function normPhone(p) {
  return String(p || "").replace(/[^\d+]/g, "");
}
function normCompany(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[«»"'‘’“”.,:;()\-–—_/\\]/g, " ")
    .replace(/\b(ооо|оао|зао|ао|ип|чп|мчж|хк|ooo|oao|llc|ltd|inc|mchj|xk|xt)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeClient(c) {
  if (!c) return null;
  return {
    id: c.id,
    company: c.company,
    position: c.position || null,
    phone: maskPhone(c.phone),
    status: c.status || "pending",
    assignedTo: c.assignedTo || null,
    tariff: c.tariff || null,
    note: c.note || null,
    inn: c.inn || null,
    mfo: c.mfo || null,
    bankAccount: c.bankAccount || null,
    address: c.address || null,
    createdAt: c.createdAt || null,
    updatedAt: c.updatedAt || null,
  };
}

/* Полная (немаскированная) карточка — только для staff */
function fullClient(c) {
  if (!c) return null;
  return { ...c };
}

async function listClients() {
  const ids = (await redis.smembers("clients")) || [];
  if (!ids.length) return [];
  const keys = ids.map((id) => "client:" + id);
  const rows = await redis.mget(...keys);
  return rows.filter(Boolean).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

async function findClientForPhone(phone) {
  const p = normPhone(phone);
  if (!p) return null;
  const id = await redis.get("clientphone:" + p);
  return id ? redis.get("client:" + id) : null;
}

async function findClientForCompany(company) {
  const n = normCompany(company);
  if (!n) return null;
  const id = await redis.get("clientcompany:" + n);
  return id ? redis.get("client:" + id) : null;
}

/* Уведомление группы бухгалтеров (без grammY — тот же приём, что и tg() выше) */
async function notifyGroup(text) {
  try {
    await tgToGroup("sendMessage", { text });
  } catch (e) { /* noop */ }
}

/* Создание/обновление клиента вручную из CRM — та же дедупликация,
   что и upsertClient() в боте: по нормализованному названию компании
   и по телефону. При конфликте (телефон уже занят другой компанией)
   не сливаем автоматически. */
async function upsertClientFromCrm({ company, phone, position, tariff, assignedTo, note }, actor) {
  if (!company || !String(company).trim()) return { ok: false, error: "company required" };
  const normC = normCompany(company);
  const normP = phone ? normPhone(phone) : null;

  const idByCompany = await redis.get("clientcompany:" + normC);
  const idByPhone = normP ? await redis.get("clientphone:" + normP) : null;

  if (idByPhone && (!idByCompany || idByCompany !== idByPhone)) {
    const phoneOwner = await redis.get("client:" + idByPhone);
    const phoneOwnerNormCompany = normCompany(phoneOwner?.company || "");
    if (phoneOwnerNormCompany && phoneOwnerNormCompany !== normC) {
      await logEvent("crm", "client_conflict", { company, phone: normP, idByCompany, idByPhone, by: actor || "CRM" });
      await notifyGroup(`⚠️ Похоже на дубликат клиента: «${company}» — телефон уже привязан к другой карточке («${phoneOwner?.company || "?"}"). Проверьте вручную в разделе «Клиенты».`);
      return { ok: false, error: "phone belongs to a different client", conflictId: idByPhone };
    }
  }

  const id = idByCompany || idByPhone;
  const now = new Date().toISOString();
  if (id) {
    const existing = (await redis.get("client:" + id)) || {};
    const merged = {
      ...existing,
      id,
      company: existing.company || company,
      position: position ?? existing.position ?? null,
      phone: existing.phone || normP,
      tariff: tariff ?? existing.tariff ?? null,
      assignedTo: assignedTo ?? existing.assignedTo ?? null,
      note: note ?? existing.note ?? null,
      status: existing.status || "pending",
      updatedAt: now,
    };
    await redis.set("client:" + id, merged);
    if (!idByCompany) await redis.set("clientcompany:" + normC, id);
    if (normP && !idByPhone) await redis.set("clientphone:" + normP, id);
    await logEvent("crm", "client_updated", { id, company: merged.company, by: actor || "CRM" });
    return { ok: true, id, merged: true, client: fullClient(merged) };
  }

  const newId = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const rec = {
    id: newId,
    company,
    position: position || null,
    phone: normP,
    tariff: tariff || null,
    assignedTo: assignedTo || null,
    note: note || null,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  await redis.set("client:" + newId, rec);
  await redis.set("clientcompany:" + normC, newId);
  if (normP) await redis.set("clientphone:" + normP, newId);
  await redis.sadd("clients", newId);
  await logEvent("crm", "client_created", { id: newId, company, by: actor || "CRM" });
  return { ok: true, id: newId, merged: false, client: fullClient(rec) };
}

async function patchClient(id, patch, actor) {
  const existing = await redis.get("client:" + id);
  if (!existing) return { ok: false, error: "client not found" };
  const allowed = ["status", "assignedTo", "tariff", "note", "position", "inn", "mfo", "bankAccount", "address"];
  const next = { ...existing };
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch || {}, k)) next[k] = patch[k];
  }
  next.updatedAt = new Date().toISOString();
  await redis.set("client:" + id, next);
  await logEvent("crm", "client_updated", { id, fields: Object.keys(patch || {}), by: actor || "CRM" });
  return { ok: true, client: fullClient(next) };
}

async function deleteClient(id, actor) {
  const existing = await redis.get("client:" + id);
  if (!existing) return { ok: false, error: "client not found" };
  const normC = normCompany(existing.company || "");
  const normP = existing.phone ? normPhone(existing.phone) : null;
  await redis.del("client:" + id);
  await redis.srem("clients", id);
  try {
    if (normC && (await redis.get("clientcompany:" + normC)) === id) await redis.del("clientcompany:" + normC);
    if (normP && (await redis.get("clientphone:" + normP)) === id) await redis.del("clientphone:" + normP);
  } catch (e) { /* индексы не критичны при отсутствии */ }
  await logEvent("crm", "client_deleted", { id, company: existing.company, by: actor || "CRM" });
  return { ok: true, id };
}

function genPassword() {
  // 8 читаемых символов без похожих друг на друга (0/O, 1/l/I) — та же схема, что у клиентов в боте
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  let out = "";
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function safeEmployee(e) {
  if (!e) return null;
  return {
    id: e.id,
    name: e.name,
    phone: e.phone || null,
    role: e.role || "accountant",
    active: e.active !== false,
    createdAt: e.createdAt || null,
  };
}

async function listEmployees() {
  const ids = (await redis.smembers("employees")) || [];
  if (!ids.length) return [];
  const rows = (await redis.mget(...ids.map((id) => "employee:" + id))).filter(Boolean);
  return rows.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
}

async function createEmployee({ name, phone, role }, actor) {
  const cleanName = String(name || "").trim();
  if (!cleanName) return { ok: false, error: "name required" };
  const normP = normPhone(phone);
  if (!normP) return { ok: false, error: "phone required" };

  const existingId = await redis.get("staffphone:" + normP);
  if (existingId) return { ok: false, error: "phone already used by another employee" };
  if (await redis.get("authphone:" + normP)) {
    return { ok: false, error: "phone already used by a client" };
  }

  const password = genPassword();
  const id = "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const emp = {
    id,
    name: cleanName,
    phone: normP,
    role: role === "admin" ? "admin" : "accountant",
    active: true,
    createdAt: new Date().toISOString(),
    pwdHash: bcrypt.hashSync(password, 10),
  };
  await redis.set("employee:" + id, emp);
  await redis.set("staffphone:" + normP, id);
  await redis.sadd("employees", id);
  await logEvent("crm", "employee_created", { id, name: cleanName, role: emp.role, by: actor || "CRM" });
  return { ok: true, employee: safeEmployee(emp), password };
}

async function patchEmployee(id, patch, actor) {
  const existing = await redis.get("employee:" + id);
  if (!existing) return { ok: false, error: "employee not found" };
  const next = { ...existing };
  if (Object.prototype.hasOwnProperty.call(patch || {}, "name") && patch.name) next.name = String(patch.name).trim();
  if (Object.prototype.hasOwnProperty.call(patch || {}, "role") && (patch.role === "admin" || patch.role === "accountant")) next.role = patch.role;
  if (Object.prototype.hasOwnProperty.call(patch || {}, "active")) next.active = !!patch.active;
  next.updatedAt = new Date().toISOString();
  await redis.set("employee:" + id, next);
  await logEvent("crm", "employee_updated", { id, fields: Object.keys(patch || {}), by: actor || "CRM" });
  return { ok: true, employee: safeEmployee(next) };
}

async function resetEmployeePassword(id, actor) {
  const existing = await redis.get("employee:" + id);
  if (!existing) return { ok: false, error: "employee not found" };
  const password = genPassword();
  existing.pwdHash = bcrypt.hashSync(password, 10);
  existing.updatedAt = new Date().toISOString();
  await redis.set("employee:" + id, existing);
  await logEvent("crm", "employee_password_reset", { id, by: actor || "CRM" });
  return { ok: true, employee: safeEmployee(existing), password };
}

async function deleteEmployee(id, actor) {
  const existing = await redis.get("employee:" + id);
  if (!existing) return { ok: false, error: "employee not found" };
  await redis.del("employee:" + id);
  await redis.srem("employees", id);
  try {
    if (existing.phone && (await redis.get("staffphone:" + existing.phone)) === id) {
      await redis.del("staffphone:" + existing.phone);
    }
  } catch (e) { /* индекс не критичен */ }
  await logEvent("crm", "employee_deleted", { id, name: existing.name, by: actor || "CRM" });
  return { ok: true, id };
}

const DEMO_CLIENT = {
  id: "demo1", company: "Демо ООО «Пример»", position: "Главный бухгалтер",
  phone: "+998 *** ** 00", status: "active", assignedTo: "Демо-бухгалтер",
  tariff: "Стандарт", note: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};

async function listTasks() {
  const n = Number((await redis.get("counter:task")) || 0);
  if (!n) return [];
  const max = 100 + n;
  const from = Math.max(101, max - 99);
  const keys = [];
  for (let i = max; i >= from; i--) keys.push("task:" + i);
  const rows = keys.length ? await redis.mget(...keys) : [];
  return rows.filter(Boolean).map(safeTask);
}

async function createTaskFromCrm({ clientId, company, text, assignee, dueDate }, actor) {
  const cleanText = formatSumsInText(String(text || "").trim());
  if (!cleanText) return { ok: false, error: "text required" };
  const cleanDue = /^\d{4}-\d{2}-\d{2}$/.test(String(dueDate || "")) ? dueDate : null;

  let telegramId = null;
  let finalCompany = company || null;
  if (clientId) {
    const c = await redis.get("client:" + clientId);
    if (!c) return { ok: false, error: "client not found" };
    telegramId = c.telegramId || null;
    finalCompany = c.company;
  }
  if (!finalCompany || !String(finalCompany).trim()) {
    return { ok: false, error: "company required" };
  }

  const n = await redis.incr("counter:task");
  const num = 100 + n;
  const task = {
    num,
    client: telegramId,
    company: finalCompany,
    text: cleanText,
    files: [],
    status: assignee ? "in_progress" : "new",
    assignee: assignee || null,
    createdAt: new Date().toISOString(),
    source: "crm",
    dueDate: cleanDue,
  };
  await redis.set("task:" + num, task);
  if (cleanDue) await redis.sadd("tasks:withdue", num);
  if (telegramId) {
    await redis.lpush("utasks:" + telegramId, num);
    await redis.ltrim("utasks:" + telegramId, 0, 19);
  }
  await logEvent("crm", "task_created", { num, company: finalCompany, clientId: clientId || null, by: actor || "CRM" });

  /* Карточка в группе бухгалтеров — тот же формат, что и у карточек из бота */
  try {
    const header =
      `🆕 Задача №${num}\n🏢 Компания: ${finalCompany}\n——————————\n` +
      `${cleanText.slice(0, 3600)}\n\n` +
      `${STATUS_LINE[task.status] || task.status}` +
      (task.assignee ? `\n👩‍💼 Исполнитель: ${task.assignee}` : "") +
      `\n✍️ Заведена из CRM: ${actor || "CRM"}` +
      (task.status === "new" ? `\n👉 Назначьте исполнителя и статус — в CRM.` : "");
    const sent = await tgToGroup("sendMessage", { text: header });
    if (sent && sent.ok && sent.result && sent.result.message_id) {
      task.gmsg = sent.result.message_id;
      await redis.set("task:" + num, task);
    } else if (!sent || !sent.ok) {
      await logEvent("crm", "group_card_failed", { num, reason: (sent && sent.description) || "unknown" });
    }
  } catch (e) { /* карточка не критична */ }

  /* Уведомляем клиента в его языке, если он привязан к телеграму */
  try {
    if (telegramId) {
      const u = await redis.get("user:" + telegramId);
      const lang = (u && u.lang) || "ru";
      await tg("sendMessage", { chat_id: telegramId, text: MSG[lang].createdByCrm(num, cleanText) });
    }
  } catch (e) { /* noop */ }

  return { ok: true, task: safeTask(task) };
}

async function patchTask(num, patch, actor) {
  const task = await redis.get("task:" + num);
  if (!task) return { ok: false, error: "task not found" };
  const allowed = ["text", "assignee", "company"];
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch || {}, k)) {
      task[k] = k === "text" ? formatSumsInText(patch[k]) : patch[k];
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch || {}, "dueDate")) {
    const raw = patch.dueDate;
    const cleanDue = raw && /^\d{4}-\d{2}-\d{2}$/.test(String(raw)) ? raw : null;
    task.dueDate = cleanDue;
    if (cleanDue) await redis.sadd("tasks:withdue", num);
    else await redis.srem("tasks:withdue", num);
    // сбрасываем отметку о последнем напоминании — дата изменилась
    delete task.lastReminderDate;
  }
  task.updatedAt = new Date().toISOString();
  await redis.set("task:" + num, task);
  await logEvent("crm", "task_updated", { num, fields: Object.keys(patch || {}), by: actor || "CRM" });
  return { ok: true, task: safeTask(task) };
}

/* Прикрепление файла к задаче из веб-CRM (не из Telegram): у браузера нет
   Telegram file_id, поэтому реальные байты файла отправляются в группу
   бухгалтеров через Bot API (sendPhoto/sendDocument), а полученный оттуда
   file_id сохраняется в task.files — так вложение остаётся в той же
   Telegram-инфраструктуре, что и файлы, приходящие из бота. */
async function sendTgFile(group, method, field, buf, filename, mimeType, caption, replyTo) {
  const form = new FormData();
  form.append("chat_id", String(group));
  if (caption) form.append("caption", caption);
  if (replyTo) {
    form.append("reply_to_message_id", String(replyTo));
    /* Если сообщение, на которое ссылаемся, к этому моменту удалено или
       недоступно, Telegram без этого флага отклонит ВЕСЬ запрос (и файл
       вместе с ним) с "Bad Request: message to reply not found" — из-за
       этого валидные вложения падали с общей ошибкой "Telegram отклонил
       файл". allow_sending_without_reply просто отправляет файл обычным
       сообщением в таком случае, вместо жёсткого отказа. */
    form.append("allow_sending_without_reply", "true");
  }
  form.append(field, new Blob([buf], { type: mimeType || "application/octet-stream" }), filename || "file");
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: "POST", body: form });
  return r.json();
}

async function sendTgFileToGroup(method, field, buf, filename, mimeType, caption, replyTo) {
  let group = await redis.get("group");
  if (!group) return { ok: false, error: "no group" };
  let resp = await sendTgFile(group, method, field, buf, filename, mimeType, caption, replyTo);
  const migrated = resp && !resp.ok && resp.parameters && resp.parameters.migrate_to_chat_id;
  if (migrated) {
    group = resp.parameters.migrate_to_chat_id;
    await redis.set("group", group);
    resp = await sendTgFile(group, method, field, buf, filename, mimeType, caption, replyTo);
  }
  return resp;
}

async function attachFileToTask(task, buf, filename, mimeType, actor, fromClient) {
  const group = await redis.get("group");
  if (!group) return { ok: false, error: "Группа бухгалтеров не настроена — файл не отправлен" };

  const isImage = /^image\//.test(mimeType || "");
  const caption = `📎 к задаче №${task.num} (из CRM, от ${actor || "CRM"})`.slice(0, 1024);

  let resp;
  try {
    resp = await sendTgFileToGroup(isImage ? "sendPhoto" : "sendDocument", isImage ? "photo" : "document", buf, filename, mimeType, caption, task.gmsg);
    /* Некоторые форматы (webp/heic и т.п.) Telegram принимает как документ,
       но отклоняет как фото — пробуем ещё раз документом, прежде чем сдаться. */
    if (isImage && (!resp || !resp.ok)) {
      resp = await sendTgFileToGroup("sendDocument", "document", buf, filename, mimeType, caption, task.gmsg);
    }
  } catch (e) {
    return { ok: false, error: "Не удалось отправить файл в Telegram" };
  }
  if (!resp || !resp.ok) {
    await logEvent("crm", "task_file_rejected", { num: task.num, by: actor || "CRM", reason: (resp && resp.description) || "unknown" });
    return { ok: false, error: "Telegram отклонил файл" + (resp && resp.description ? `: ${resp.description}` : "") };
  }

  const result = resp.result || {};
  let fileEntry = null;
  if (Array.isArray(result.photo) && result.photo.length) {
    fileEntry = { kind: "photo", file_id: result.photo[result.photo.length - 1].file_id };
  } else if (result.document) {
    fileEntry = { kind: "document", file_id: result.document.file_id };
  }
  if (!fileEntry) return { ok: false, error: "Не удалось определить загруженный файл" };

  /* Если файл прикрепил бухгалтер/админ (не сам клиент) — пересылаем его
     клиенту в личку, как и в случае с реплаем на карточку в группе. */
  if (!fromClient && task.client) {
    try {
      const clientCaption = `📎 к задаче №${task.num} (от бухгалтерии)`;
      const clientMethod = fileEntry.kind === "photo" ? "sendPhoto" : "sendDocument";
      const clientField = fileEntry.kind === "photo" ? "photo" : "document";
      await tg(clientMethod, { chat_id: task.client, [clientField]: fileEntry.file_id, caption: clientCaption });
    } catch (e) { /* доставка клиенту не критична для самого прикрепления */ }
  }

  task.files = Array.isArray(task.files) ? task.files : [];
  task.files.push(fileEntry);
  task.updatedAt = new Date().toISOString();
  await redis.set("task:" + task.num, task);
  await logEvent("crm", "task_file_attached", { num: task.num, by: actor || "CRM" });
  return { ok: true, task: safeTask(task) };
}

/* --- Календарь напоминаний: задачи со сроком (dueDate), индекс —
   множество "tasks:withdue" (номера задач с непустым dueDate). При
   выполнении задачи (updateStatus → done) убираем её из индекса,
   чтобы не слать напоминания по закрытым задачам. --------------- */
async function listCalendar(companyFilter) {
  const nums = await redis.smembers("tasks:withdue");
  if (!nums || !nums.length) return [];
  const keys = nums.map((n) => "task:" + n);
  const rows = (await redis.mget(...keys)).filter(Boolean);
  const todayStr = tashkentDateStr();
  let list = rows
    .filter((t) => t.dueDate && t.status !== "done")
    .map((t) => ({
      num: t.num,
      company: t.company,
      text: t.text,
      status: t.status,
      assignee: t.assignee || null,
      dueDate: t.dueDate,
      overdue: t.dueDate < todayStr,
      dueToday: t.dueDate === todayStr,
    }));
  if (companyFilter) list = list.filter((t) => normCompany(t.company) === normCompany(companyFilter));
  list.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
  return list;
}

/* --- Повторяющиеся события календаря (налоги/платежи) — отдельное
   хранилище, не связанное с задачами: calendarevent:<id> + индекс
   "calendarevents" (SET id-шников). "date" — дата СЛЕДУЮЩЕГО срабатывания;
   после наступления даты cron/reminders.js либо переносит её на следующий
   период (repeat != "once"), либо деактивирует событие. ------------- */
function safeCalendarEvent(e) {
  if (!e) return null;
  return {
    id: e.id,
    type: e.type,
    title: e.title,
    company: e.company || null,
    date: e.date,
    repeat: e.repeat || "once",
    remindDays: typeof e.remindDays === "number" ? e.remindDays : 3,
    active: e.active !== false,
    status: CE_STATUSES.includes(e.status) ? e.status : "new",
    createdAt: e.createdAt || null,
  };
}

async function listCalendarEvents() {
  const ids = (await redis.smembers("calendarevents")) || [];
  if (!ids.length) return [];
  const keys = ids.map((id) => "calendarevent:" + id);
  const rows = (await redis.mget(...keys)).filter(Boolean);
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

const CE_REPEATS = ["once", "monthly", "quarterly", "yearly"];
const CE_REMIND_OPTIONS = [0, 1, 3, 7];
const CE_STATUSES = ["new", "in_progress", "done"];

async function createCalendarEvent(body, actor) {
  const { type, title, company, date, repeat, remindDays } = body || {};
  if (!["tax", "pay"].includes(type)) return { ok: false, error: "type must be tax or pay" };
  if (!title || !String(title).trim()) return { ok: false, error: "title required" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return { ok: false, error: "date must be YYYY-MM-DD" };
  const rep = CE_REPEATS.includes(repeat) ? repeat : "once";
  const rd = CE_REMIND_OPTIONS.includes(Number(remindDays)) ? Number(remindDays) : 3;
  const id = "ce" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const ev = {
    id, type, title: formatSumsInText(String(title).trim()),
    company: company ? String(company).trim() : null,
    date: String(date), repeat: rep, remindDays: rd,
    active: true, status: "new", lastNotifiedDate: null,
    createdAt: new Date().toISOString(),
  };
  await redis.set("calendarevent:" + id, ev);
  await redis.sadd("calendarevents", id);
  await logEvent("crm", "calendar_event_created", { id, title: ev.title, by: actor || "CRM" });
  return { ok: true, event: safeCalendarEvent(ev) };
}

async function patchCalendarEvent(id, patch, actor) {
  const existing = await redis.get("calendarevent:" + id);
  if (!existing) return { ok: false, error: "not found" };
  const next = { ...existing };
  const p = patch || {};
  if (p.title !== undefined && String(p.title).trim()) next.title = formatSumsInText(String(p.title).trim());
  if (p.company !== undefined) next.company = p.company ? String(p.company).trim() : null;
  if (p.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(String(p.date))) next.date = String(p.date);
  if (p.repeat !== undefined && CE_REPEATS.includes(p.repeat)) next.repeat = p.repeat;
  if (p.remindDays !== undefined && CE_REMIND_OPTIONS.includes(Number(p.remindDays))) next.remindDays = Number(p.remindDays);
  if (p.status !== undefined && CE_STATUSES.includes(p.status)) next.status = p.status;
  if (p.active !== undefined) next.active = !!p.active;
  next.updatedAt = new Date().toISOString();
  await redis.set("calendarevent:" + id, next);
  await logEvent("crm", "calendar_event_updated", { id, by: actor || "CRM" });
  return { ok: true, event: safeCalendarEvent(next) };
}

async function deleteCalendarEvent(id, actor) {
  const existing = await redis.get("calendarevent:" + id);
  if (!existing) return { ok: false, error: "not found" };
  await redis.del("calendarevent:" + id);
  await redis.srem("calendarevents", id);
  await logEvent("crm", "calendar_event_deleted", { id, title: existing.title, by: actor || "CRM" });
  return { ok: true };
}

function tashkentDateStr(d) {
  const dt = d || new Date();
  // Ташкент UTC+5, без перехода на летнее время
  const t = new Date(dt.getTime() + 5 * 3600 * 1000);
  return t.toISOString().slice(0, 10);
}

async function deleteTask(num, actor) {
  const task = await redis.get("task:" + num);
  if (!task) return { ok: false, error: "task not found" };
  await redis.del("task:" + num);
  await redis.srem("tasks:withdue", num);
  await logEvent("crm", "task_deleted", { num, company: task.company, by: actor || "CRM" });
  return { ok: true, num };
}

async function updateStatus(num, status, assignee) {
  const task = await redis.get("task:" + num);
  if (!task) return { ok: false, error: "task not found" };
  const prev = task.status;
  task.status = status;
  if (status === "in_progress") task.assignee = assignee || task.assignee || "CRM";
  if (status === "done") task.doneAt = new Date().toISOString();
  else if (prev === "done" && status !== "done") task.doneAt = null; // вернули в работу — снимаем метку архивации
  await redis.set("task:" + num, task);
  await logEvent("crm", "status_changed", {
    num, from: prev, to: status,
    assignee: task.assignee || null, by: assignee || "CRM",
  });

  /* Обновляем карточку в группе бухгалтеров */
  try {
    if (task.gmsg) {
      const header =
        `🆕 Задача №${num}\n🏢 Компания: ${task.company}\n——————————\n` +
        `${String(task.text).slice(0, 3600)}` +
        (task.files && task.files.length ? `\n📎 Вложений: ${task.files.length}` : "") +
        `\n\n${STATUS_LINE[status] || status}` +
        (task.assignee && status !== "new" ? `\n👩‍💼 Исполнитель: ${task.assignee}` : "") +
        (status === "new" ? `\n👉 Назначьте исполнителя и статус — в CRM.` : "");
      await tgToGroup("editMessageText", { message_id: task.gmsg, text: header });
    }
  } catch (e) { /* карточки может не быть — не критично */ }

  /* Уведомляем клиента */
  try {
    if (task.client && prev !== status) {
      const u = await redis.get("user:" + task.client);
      const m = MSG[(u && u.lang) || "ru"];
      const text =
        status === "done" ? m.done(num)
        : status === "in_progress" ? m.assigned(num, task.assignee || "бухгалтер")
        : m.reopened(num);
      await tg("sendMessage", { chat_id: task.client, text });
    }
  } catch (e) { /* noop */ }

  return { ok: true, task: safeTask(task) };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", resolveOrigin(req));
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-api-key,authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (!checkApiKey(req)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const q = req.query || {};
  const authUser = getAuthUser(req);
  const rolesEnforced = !!JWT_SECRET; // как только задан секрет — роли обязательны
  const isStaff = !rolesEnforced || (authUser && (authUser.role === "admin" || authUser.role === "accountant"));

  if (rolesEnforced && !authUser && q.r !== "ping") {
    return res.status(401).json({ ok: false, error: "auth required" });
  }

  try {
    if (req.method === "GET") {
      if (q.r === "ping") {
        const [n, group] = await Promise.all([redis.get("counter:task"), redis.get("group")]);
        return res.status(200).json({ ok: true, tasks: Number(n || 0), group: !!group, bot: "@finpulse_crm_bot" });
      }
      if (q.r === "tasks") {
        if (rolesEnforced && authUser.role === "guest") {
          return res.status(200).json({ ok: true, tasks: DEMO_TASKS, demo: true });
        }
        let tasks = await listTasks();
        if (rolesEnforced && authUser.role === "client") {
          tasks = tasks.filter((t) => t.company === authUser.company);
        }
        return res.status(200).json({ ok: true, tasks });
      }
      if (q.r === "logs") {
        if (!isStaff) return res.status(403).json({ ok: false, error: "forbidden" });
        const src = q.src === "crm" ? "crm" : "telegram";
        const rows = (await redis.lrange("logs:" + src, 0, 199)) || [];
        const logs = rows.map((r) => { try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } }).filter(Boolean);
        return res.status(200).json({ ok: true, src, logs });
      }
      if (q.r === "pending") {
        if (!isStaff) return res.status(403).json({ ok: false, error: "forbidden" });
        const rows = (await redis.lrange("pending_clients", 0, 49)) || [];
        const pending = rows.map((r) => { try { const o = typeof r === "string" ? JSON.parse(r) : r; return { company: o.company, phone: maskPhone(o.phone), at: o.at || o.ts || null }; } catch { return null; } }).filter(Boolean);
        return res.status(200).json({ ok: true, pending });
      }
      if (q.r === "clients") {
        if (rolesEnforced && authUser.role === "guest") {
          return res.status(200).json({ ok: true, clients: [DEMO_CLIENT], demo: true });
        }
        if (rolesEnforced && authUser.role === "client") {
          const mine = await findClientForCompany(authUser.company);
          return res.status(200).json({ ok: true, clients: mine ? [fullClient(mine)] : [] });
        }
        const all = await listClients();
        const isAdmin = !rolesEnforced || authUser.role === "admin";
        return res.status(200).json({ ok: true, clients: all.map(isAdmin ? fullClient : safeClient) });
      }
      if (q.r === "client") {
        if (!q.id) return res.status(200).json({ ok: false, error: "id required" });
        const c = await redis.get("client:" + q.id);
        if (!c) return res.status(404).json({ ok: false, error: "not found" });
        if (rolesEnforced && authUser.role === "guest") {
          return res.status(200).json({ ok: true, client: DEMO_CLIENT });
        }
        if (rolesEnforced && authUser.role === "client") {
          if (normCompany(c.company) !== normCompany(authUser.company || "")) {
            return res.status(403).json({ ok: false, error: "forbidden" });
          }
          return res.status(200).json({ ok: true, client: fullClient(c) });
        }
        const isAdmin = !rolesEnforced || authUser.role === "admin";
        return res.status(200).json({ ok: true, client: (isAdmin ? fullClient : safeClient)(c) });
      }
      if (q.r === "calendar") {
        if (rolesEnforced && authUser.role === "guest") {
          return res.status(200).json({ ok: true, calendar: [], demo: true });
        }
        const companyFilter = rolesEnforced && authUser.role === "client" ? authUser.company : null;
        const calendar = await listCalendar(companyFilter);
        return res.status(200).json({ ok: true, calendar });
      }
      if (q.r === "employees") {
        if (rolesEnforced && authUser.role === "guest") {
          return res.status(200).json({ ok: true, employees: DEMO_EMPLOYEES, demo: true });
        }
        const isAdmin = !rolesEnforced || (authUser && authUser.role === "admin");
        if (!isAdmin) return res.status(403).json({ ok: false, error: "forbidden" });
        const employees = (await listEmployees()).map(safeEmployee);
        return res.status(200).json({ ok: true, employees });
      }
      if (q.r === "task_file") {
        if (rolesEnforced && authUser.role === "guest") {
          return res.status(403).json({ ok: false, error: "forbidden" });
        }
        if (!q.num || q.i === undefined) {
          return res.status(200).json({ ok: false, error: "num and i required" });
        }
        const task = await redis.get("task:" + Number(q.num));
        if (!task) return res.status(404).json({ ok: false, error: "not found" });
        if (rolesEnforced && authUser.role === "client" && normCompany(task.company) !== normCompany(authUser.company || "")) {
          return res.status(403).json({ ok: false, error: "forbidden" });
        }
        if (rolesEnforced && !isStaff && authUser.role !== "client") {
          return res.status(403).json({ ok: false, error: "forbidden" });
        }
        const f = Array.isArray(task.files) ? task.files[Number(q.i)] : null;
        if (!f) return res.status(404).json({ ok: false, error: "file not found" });
        try {
          const metaResp = await fetch(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${encodeURIComponent(f.file_id)}`);
          const meta = await metaResp.json();
          if (!meta.ok) return res.status(502).json({ ok: false, error: "telegram file error" });
          const filePath = meta.result.file_path || "";
          const fileResp = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${filePath}`);
          if (!fileResp.ok) return res.status(502).json({ ok: false, error: "telegram download error" });
          const buf = Buffer.from(await fileResp.arrayBuffer());
          const ext = (filePath.split(".").pop() || "bin").toLowerCase();
          const MIME = {
            jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
            pdf: "application/pdf", doc: "application/msword",
            docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            xls: "application/vnd.ms-excel",
            xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            mp4: "video/mp4", ogg: "audio/ogg", oga: "audio/ogg", mp3: "audio/mpeg",
          };
          res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
          res.setHeader("Content-Disposition", `inline; filename="task-${q.num}-${q.i}.${ext}"`);
          return res.status(200).send(buf);
        } catch (e) {
          return res.status(502).json({ ok: false, error: "failed to fetch file" });
        }
      }
      if (q.r === "calendar_events") {
        if (rolesEnforced && authUser.role === "guest") {
          return res.status(200).json({ ok: true, events: [], demo: true });
        }
        let events = (await listCalendarEvents()).map(safeCalendarEvent);
        if (rolesEnforced && authUser.role === "client") {
          events = events.filter((e) => !e.company || normCompany(e.company) === normCompany(authUser.company || ""));
        }
        return res.status(200).json({ ok: true, events });
      }
      return res.status(200).json({ ok: true, service: "Finpulse CRM API", routes: ["ping", "tasks", "logs", "pending", "clients", "client", "calendar", "calendar_events", "employees"] });
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
      const isClient = rolesEnforced && authUser && authUser.role === "client";
      /* Гость (демо-доступ) может "создать задачу"/"прикрепить файл", чтобы
         попробовать интерфейс, но ничего не пишется в реальную БД — это
         имитация, ответ строится на лету (см. ветки task_create/
         task_attach_file ниже). */
      const isGuest = rolesEnforced && authUser && authUser.role === "guest";

      /* task_create / task_update — единственные POST-действия, доступные
         клиенту: он может создать задачу и отредактировать её текст/срок,
         но не статус, исполнителя или компанию — это остаётся за
         бухгалтерами/админом. Всё остальное ниже по-прежнему требует
         isStaff (или isAdmin для деструктивных действий). */
      if (!isStaff && !isClient && !isGuest) return res.status(403).json({ ok: false, error: "forbidden" });

      if (body && body.action === "status" && body.num && body.status) {
        if (!isStaff) return res.status(403).json({ ok: false, error: "forbidden" });
        if (!["new", "in_progress", "done"].includes(body.status)) {
          return res.status(200).json({ ok: false, error: "bad status" });
        }
        const r = await updateStatus(Number(body.num), body.status, body.assignee);
        return res.status(200).json(r);
      }
      if (body && body.action === "client_create") {
        if (!isStaff) return res.status(403).json({ ok: false, error: "forbidden" });
        const actor = (authUser && authUser.name) || "CRM";
        const r = await upsertClientFromCrm(body, actor);
        return res.status(200).json(r);
      }
      if (body && body.action === "client_update" && body.id) {
        if (!isStaff) return res.status(403).json({ ok: false, error: "forbidden" });
        const actor = (authUser && authUser.name) || "CRM";
        const r = await patchClient(body.id, body.patch || {}, actor);
        return res.status(200).json(r);
      }
      if (body && body.action === "task_create") {
        if (!isStaff && !isClient && !isGuest) return res.status(403).json({ ok: false, error: "forbidden" });
        if (isGuest) {
          const cleanText = formatSumsInText(String(body.text || "").trim());
          if (!cleanText) return res.status(200).json({ ok: false, error: "text required" });
          const fakeTask = {
            num: 9000 + Math.floor(Math.random() * 900),
            company: "Демо ООО «Пример»", text: cleanText, status: "new", assignee: null,
            createdAt: new Date().toISOString(), files: [], dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(body.dueDate || "")) ? body.dueDate : null,
            source: "crm",
          };
          return res.status(200).json({ ok: true, task: safeTask(fakeTask), demo: true });
        }
        const actor = (authUser && authUser.name) || "CRM";
        let payload = body;
        if (isClient) {
          const mine = await findClientForCompany(authUser.company);
          payload = { clientId: mine ? mine.id : null, company: authUser.company, text: body.text, dueDate: body.dueDate };
        }
        const r = await createTaskFromCrm(payload, actor);
        return res.status(200).json(r);
      }
      if (body && body.action === "task_update" && body.num) {
        if (!isStaff && !isClient) return res.status(403).json({ ok: false, error: "forbidden" });
        const actor = (authUser && authUser.name) || "CRM";
        let patch = body.patch || {};
        if (isClient) {
          const task = await redis.get("task:" + Number(body.num));
          if (!task || normCompany(task.company) !== normCompany(authUser.company || "")) {
            return res.status(403).json({ ok: false, error: "forbidden" });
          }
          const clientPatch = {};
          if (typeof patch.text === "string") clientPatch.text = patch.text;
          if (patch.dueDate === null || typeof patch.dueDate === "string") clientPatch.dueDate = patch.dueDate;
          patch = clientPatch;
        }
        const r = await patchTask(Number(body.num), patch, actor);
        return res.status(200).json(r);
      }
      if (body && body.action === "task_attach_file" && body.num) {
        if (!isStaff && !isClient && !isGuest) return res.status(403).json({ ok: false, error: "forbidden" });
        if (isGuest) {
          return res.status(200).json({ ok: true, demo: true });
        }
        const task = await redis.get("task:" + Number(body.num));
        if (!task) return res.status(200).json({ ok: false, error: "task not found" });
        if (isClient && normCompany(task.company) !== normCompany(authUser.company || "")) {
          return res.status(403).json({ ok: false, error: "forbidden" });
        }
        const { filename, mimeType, dataBase64 } = body;
        if (!dataBase64) return res.status(200).json({ ok: false, error: "file required" });
        let buf;
        try { buf = Buffer.from(dataBase64, "base64"); } catch { return res.status(200).json({ ok: false, error: "bad file data" }); }
        if (buf.length > 9 * 1024 * 1024) {
          return res.status(200).json({ ok: false, error: "Файл слишком большой (максимум 9 МБ)" });
        }
        const actor = (authUser && authUser.name) || "CRM";
        const r = await attachFileToTask(task, buf, filename, mimeType, actor, isClient);
        return res.status(200).json(r);
      }
      if (body && body.action === "client_delete" && body.id) {
        const isAdmin = !rolesEnforced || (authUser && authUser.role === "admin");
        if (!isAdmin) return res.status(403).json({ ok: false, error: "forbidden" });
        const actor = (authUser && authUser.name) || "CRM";
        const r = await deleteClient(body.id, actor);
        return res.status(200).json(r);
      }
      if (body && body.action === "task_delete" && body.num) {
        const isAdmin = !rolesEnforced || (authUser && authUser.role === "admin");
        if (!isAdmin) return res.status(403).json({ ok: false, error: "forbidden" });
        const actor = (authUser && authUser.name) || "CRM";
        const r = await deleteTask(Number(body.num), actor);
        return res.status(200).json(r);
      }
      if (body && body.action === "employee_create") {
        const isAdmin = !rolesEnforced || (authUser && authUser.role === "admin");
        if (!isAdmin) return res.status(403).json({ ok: false, error: "forbidden" });
        const actor = (authUser && authUser.name) || "CRM";
        const r = await createEmployee(body, actor);
        return res.status(200).json(r);
      }
      if (body && body.action === "employee_update" && body.id) {
        const isAdmin = !rolesEnforced || (authUser && authUser.role === "admin");
        if (!isAdmin) return res.status(403).json({ ok: false, error: "forbidden" });
        const actor = (authUser && authUser.name) || "CRM";
        const r = await patchEmployee(body.id, body.patch || {}, actor);
        return res.status(200).json(r);
      }
      if (body && body.action === "employee_reset_password" && body.id) {
        const isAdmin = !rolesEnforced || (authUser && authUser.role === "admin");
        if (!isAdmin) return res.status(403).json({ ok: false, error: "forbidden" });
        const actor = (authUser && authUser.name) || "CRM";
        const r = await resetEmployeePassword(body.id, actor);
        return res.status(200).json(r);
      }
      if (body && body.action === "employee_delete" && body.id) {
        const isAdmin = !rolesEnforced || (authUser && authUser.role === "admin");
        if (!isAdmin) return res.status(403).json({ ok: false, error: "forbidden" });
        const actor = (authUser && authUser.name) || "CRM";
        const r = await deleteEmployee(body.id, actor);
        return res.status(200).json(r);
      }
      if (body && body.action === "calendar_event_create") {
        if (!isStaff) return res.status(403).json({ ok: false, error: "forbidden" });
        const actor = (authUser && authUser.name) || "CRM";
        const r = await createCalendarEvent(body, actor);
        return res.status(200).json(r);
      }
      if (body && body.action === "calendar_event_update" && body.id) {
        if (!isStaff) return res.status(403).json({ ok: false, error: "forbidden" });
        const actor = (authUser && authUser.name) || "CRM";
        const r = await patchCalendarEvent(body.id, body.patch || {}, actor);
        return res.status(200).json(r);
      }
      if (body && body.action === "calendar_event_delete" && body.id) {
        const isAdmin = !rolesEnforced || (authUser && authUser.role === "admin");
        if (!isAdmin) return res.status(403).json({ ok: false, error: "forbidden" });
        const actor = (authUser && authUser.name) || "CRM";
        const r = await deleteCalendarEvent(body.id, actor);
        return res.status(200).json(r);
      }
      return res.status(200).json({ ok: false, error: "unknown action" });
    }

    res.status(405).json({ ok: false });
  } catch (e) {
    console.error("crm api:", e);
    res.status(200).json({ ok: false, error: String(e).slice(0, 300) });
  }
};
