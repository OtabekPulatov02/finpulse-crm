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
const { DEFAULT_CATEGORIES } = require("../lib/knowledge.js");
const { computeAssignPatch, getAssignRules, saveAssignRules } = require("../lib/assign.js");
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

if (!ALLOWED_ORIGINS.length) {
  console.warn("SECURITY: CRM_ALLOWED_ORIGINS не задан — CORS отражает любой Origin (эффективно без ограничения).");
}
if (API_KEY && API_KEY.length < 32) {
  console.warn("SECURITY: CRM_API_KEY короче 32 символов — увеличьте длину секрета.");
}

function resolveOrigin(req) {
  const origin = req.headers.origin || "";
  if (!ALLOWED_ORIGINS.length) return origin || "*"; // список ещё не настроен — не ломаем текущую работу
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

/* Сравнение за постоянное время — обычное === для сравнения секретов
   теоретически позволяет измерять тайминг посимвольного сравнения.
   timingSafeEqual требует буферы одинаковой длины, поэтому сначала явно
   проверяем длину (длина ключа сама по себе не секрет). */
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  if (bufA.length !== bufB.length) return false;
  try { return crypto.timingSafeEqual(bufA, bufB); } catch { return false; }
}

function checkApiKey(req) {
  if (!API_KEY) return true; // ключ ещё не задан в env — пропускаем (переходный период)
  return timingSafeStringEqual(req.headers["x-api-key"], API_KEY);
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
if (JWT_SECRET && JWT_SECRET.length < 32) {
  console.warn("SECURITY: JWT_SECRET короче 32 символов — увеличьте длину секрета.");
}

/* Триггер автономного режима ИИ-бухгалтера (тумблер AI → «Автономный
   ИИ-бухгалтер») — вызывается сразу после отправки карточки задачи в
   группу. Сам /api/ai auto_work перепроверяет тумблер и молча выходит,
   если автономность выключена, так что вызывать можно безусловно.
   Ошибки не должны ломать создание задачи — поэтому best-effort. */
const AI_API_ORIGIN = process.env.CRM_API_ORIGIN || "https://finpulse-crm.vercel.app";
async function triggerAutoWork(num, extraContext, aiqInfo) {
  if (!JWT_SECRET) return;
  try {
    const token = jwt.sign({ role: "admin", name: "CRM (авто-триггер)" }, JWT_SECRET, { algorithm: "HS256", expiresIn: "3m" });
    await fetch(`${AI_API_ORIGIN}/api/ai`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "auto_work", num, ...(extraContext ? { extraContext } : {}), ...(aiqInfo ? { aiqInfo } : {}) }),
      signal: AbortSignal.timeout(55000),
    });
  } catch (e) { console.error("triggerAutoWork:", num, String(e).slice(0, 200)); }
}

function getAuthUser(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m || !JWT_SECRET) return null;
  try { return jwt.verify(m[1], JWT_SECRET, { algorithms: ["HS256"] }); } catch { return null; }
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
    cancelled: (n) => `🚫 Задача №${n} отменена.`,
  },
  uz: {
    assigned: (n, name) => `👩‍💼 №${n} vazifaga buxgalter tayinlandi: ${name}. Ishga tushdi!`,
    done: (n) => `✅ №${n} vazifa bajarildi. Yana savol bo'lsa — yozing 👇`,
    reopened: (n) => `🔄 №${n} vazifa qayta ishga qaytarildi.`,
    cancelled: (n) => `🚫 №${n} vazifa bekor qilindi.`,
  },
  en: {
    assigned: (n, name) => `👩‍💼 Task #${n} was assigned to accountant: ${name}. Work has started!`,
    done: (n) => `✅ Task #${n} is done. Anything else — just write 👇`,
    reopened: (n) => `🔄 Task #${n} was reopened.`,
    cancelled: (n) => `🚫 Task #${n} was cancelled.`,
  },
};

MSG.ru.createdByCrm = (n, text) => `🆕 Бухгалтерия завела для вас задачу №${n}:\n\n${text}\n\nМы уже работаем над ней.`;
MSG.uz.createdByCrm = (n, text) => `🆕 Buxgalteriya siz uchun №${n} vazifa yaratdi:\n\n${text}\n\nBiz allaqachon ishlayapmiz.`;
MSG.en.createdByCrm = (n, text) => `🆕 Accounting created task #${n} for you:\n\n${text}\n\nWe're already working on it.`;

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const STATUS_TOP = { new: "⚪️ Новая", in_progress: "🔵 В работе", done: "🟢 Выполнена", cancelled: "🚫 Отменена" };
const STATUS_LINE = {
  new: "⚪️ Статус: Новая",
  in_progress: "🔵 Статус: В работе",
  done: "🟢 Статус: Выполнена",
  cancelled: "🚫 Статус: Отменено",
};

async function logEvent(source, event, data) {
  try {
    await redis.lpush("logs:" + source, JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
    await redis.ltrim("logs:" + source, 0, 499);
  } catch (e) {
    const _archMonth = new Date().toISOString().slice(0, 7);
    redis.lpush("logs:archive:" + source + ":" + _archMonth, JSON.stringify({ ts: new Date().toISOString(), event, ...data }))
      .then(() => redis.ltrim("logs:archive:" + source + ":" + _archMonth, 0, 9999))
      .then(() => redis.expire("logs:archive:" + source + ":" + _archMonth, 60 * 60 * 24 * 420))
      .catch(() => {}); /* noop */ }
}

function safeTask(t) {
  if (!t) return null;
  return {
    num: t.num,
    company: t.company,
    text: t.text,
    status: t.status,
    category: t.category || null,
    sub: t.sub || null,
    deferred: !!t.deferred,
    assignee: t.assignee || null,
    createdAt: t.createdAt || null,
    files: Array.isArray(t.files) ? t.files.length : 0,
    /* Метаданные вложений (без file_id — он остаётся на сервере, чтобы не
       светить его в браузере; сами байты отдаются через r=task_file). */
    attachments: Array.isArray(t.files) ? t.files.map((f, i) => ({ index: i, kind: f.kind || "document" })) : [],
    dueDate: t.dueDate || null,
    priority: t.priority || null,
    aiIntake: t.aiIntake || null,
    aiDraft: t.aiDraft || null,
    source: t.source === "crm" ? "crm" : "bot",
    doneAt: t.doneAt || null,
    /* "task" — обычная задача, "reminder" — авто-созданная из календаря
       (налог/платёж); у напоминаний нет company. */
    type: t.type === "reminder" ? "reminder" : "task",
    /* Лента чата задачи (вложения + текстовые сообщения, в обе стороны).
       file_id внутри вложений не отдаём — см. attachments выше. */
    thread: Array.isArray(t.thread) ? t.thread.map((m) => ({
      id: m.id, at: m.at, from: m.from, by: m.by, text: m.text || null,
      fileIndex: typeof m.fileIndex === "number" ? m.fileIndex : null,
    })) : [],
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

/* Поля карточки клиента, совместимые с реквизитами «Организации» в 1С (БУ УЗ 3.0) */
const CLIENT_1C_FIELDS = ["inn", "fullName", "pinfl", "vatCode", "taxSystem", "bank", "mfo", "bankAccount", "address", "director", "taxOffice"];

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
    fullName: c.fullName || null,
    pinfl: c.pinfl || null,
    vatCode: c.vatCode || null,
    taxSystem: c.taxSystem || null,
    bank: c.bank || null,
    mfo: c.mfo || null,
    bankAccount: c.bankAccount || null,
    address: c.address || null,
    director: c.director || null,
    taxOffice: c.taxOffice || null,
    source1c: c.source1c || null,
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
async function upsertClientFromCrm(payload, actor) {
  const { company, phone, position, tariff, assignedTo, note } = payload || {};
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
    for (const k of CLIENT_1C_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(payload || {}, k)) merged[k] = payload[k];
    }
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
  for (const k of CLIENT_1C_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload || {}, k)) rec[k] = payload[k];
  }
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
  const allowed = ["status", "assignedTo", "tariff", "note", "position", ...CLIENT_1C_FIELDS];
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

async function createTaskFromCrm({ clientId, company, text, assignee, dueDate, type }, actor) {
  const cleanText = formatSumsInText(String(text || "").trim());
  if (!cleanText) return { ok: false, error: "text required" };
  const cleanDue = /^\d{4}-\d{2}-\d{2}$/.test(String(dueDate || "")) ? dueDate : null;
  const taskType = type === "reminder" ? "reminder" : "task";

  let telegramId = null;
  let finalCompany = company || null;
  if (clientId) {
    const c = await redis.get("client:" + clientId);
    if (!c) return { ok: false, error: "client not found" };
    telegramId = c.telegramId || null;
    finalCompany = c.company;
  }
  /* У напоминаний company может отсутствовать ("Все клиенты") — это
     осознанно допустимо. Для обычных задач company обязательна. */
  if (taskType !== "reminder" && (!finalCompany || !String(finalCompany).trim())) {
    return { ok: false, error: "company required" };
  }

  const n = await redis.incr("counter:task");
  const num = 100 + n;
  const task = {
    num,
    client: telegramId,
    company: finalCompany || null,
    text: cleanText,
    files: [],
    status: assignee ? "in_progress" : "new",
    assignee: assignee || null,
    createdAt: new Date().toISOString(),
    source: "crm",
    dueDate: cleanDue,
    type: taskType,
  };

  /* Автораспределение по правилам (Настройки → Распределение / Справочники)
     — только если задачу ещё явно никому не назначили выше. */
  if (taskType !== "reminder") {
    const assignPatch = await computeAssignPatch(redis, { text: cleanText, source: "crm", alreadyAssigned: !!assignee });
    if (assignPatch.assignee) {
      task.assignee = assignPatch.assignee;
      task.status = "in_progress";
      if (assignPatch.priority) task.priority = assignPatch.priority;
      if (assignPatch.dueDate && !task.dueDate) task.dueDate = assignPatch.dueDate;
    }
  }

  await redis.set("task:" + num, task);
  if (cleanDue) await redis.sadd("tasks:withdue", num);
  if (telegramId) {
    await redis.lpush("utasks:" + telegramId, num);
    await redis.ltrim("utasks:" + telegramId, 0, 19);
  }
  await logEvent("crm", "task_created", { num, company: finalCompany || null, clientId: clientId || null, by: actor || "CRM" });

  /* Карточка в группе бухгалтеров и личное уведомление клиенту — два
     независимых похода в Telegram API, отправляем их параллельно вместо
     последовательного ожидания (клиентское уведомление ещё и требует
     отдельного чтения user:<id> для языка — это тоже не блокирует
     отправку карточки в группу). */
  const header =
    `🆕 <b>Задача №${num}</b> · ${STATUS_TOP[task.status] || task.status}\n` +
    `🏢 <b>${escapeHtml(finalCompany || "—")}</b>\n━━━━━━━━━━━━\n` +
    `<b>${escapeHtml(cleanText.slice(0, 3600))}</b>` +
    (task.assignee ? `\n\n👩‍💼 <b>Исполнитель:</b> ${escapeHtml(task.assignee)}` : "") +
    `\n✍️ <i>Заведена из CRM: ${escapeHtml(actor || "CRM")}</i>` +
    (task.status === "new" ? `\n👉 <i>Исполнитель и статус — в CRM</i>` : "");

  const groupPromise = tgToGroup("sendMessage", { text: header, parse_mode: "HTML" }).catch(() => null);
  const clientPromise = telegramId
    ? redis.get("user:" + telegramId)
        .then((u) => (u && u.lang) || "ru")
        .then((lang) => tg("sendMessage", { chat_id: telegramId, text: MSG[lang].createdByCrm(num, cleanText) }))
        .catch(() => null)
    : Promise.resolve(null);

  const [sent] = await Promise.all([groupPromise, clientPromise]);
  if (sent && sent.ok && sent.result && sent.result.message_id) {
    task.gmsg = sent.result.message_id;
    await redis.set("task:" + num, task);
  } else if (!sent || !sent.ok) {
    await logEvent("crm", "group_card_failed", { num, reason: (sent && sent.description) || "unknown" });
  }

  await triggerAutoWork(num);

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

/* --- Чат внутри задачи (полноценный, двусторонний): сообщение,
   отправленное из CRM, реально доставляется в Telegram — сотруднику
   уходит клиенту в личку, клиенту уходит в группу бухгалтеров (реплаем
   на карточку задачи, как и обычные реплаи из Telegram). Само сообщение
   всегда сохраняется в task.thread, чтобы лента в CRM совпадала с тем,
   что видно в Telegram, независимо от того, откуда оно отправлено. */
async function sendTaskMessage(task, text, actor, fromClient, file) {
  const cleanText = formatSumsInText(String(text || "").trim());
  if (!cleanText && !file) return { ok: false, error: "text required" };

  /* Лента задачи (YouTrack-style) — это внутренняя история/чат по задаче,
     сообщения из неё НИКУДА не отправляются (ни клиенту в Telegram, ни в
     группу бухгалтеров): только хранятся в task.thread. Файлы всё ещё
     физически хранятся через Telegram (у нас нет отдельного blob-хранилища
     — group используется просто как файловый бэкенд), но без всякой
     уведомляющей подписи и без пересылки кому-либо. */
  let fileIndex = null;
  if (file && file.dataBase64) {
    let buf;
    try { buf = Buffer.from(file.dataBase64, "base64"); } catch { return { ok: false, error: "bad file data" }; }
    if (buf.length > 9 * 1024 * 1024) {
      return { ok: false, error: "Файл слишком большой (максимум 9 МБ)" };
    }
    const group = await redis.get("group");
    if (!group) return { ok: false, error: "Файловое хранилище не настроено" };
    const isImage = /^image\//.test(file.mimeType || "");
    const caption = `📎 лента задачи №${task.num}`.slice(0, 1024);
    let resp;
    try {
      resp = await sendTgFileToGroup(isImage ? "sendPhoto" : "sendDocument", isImage ? "photo" : "document", buf, file.filename, file.mimeType, caption);
      if (isImage && (!resp || !resp.ok)) {
        resp = await sendTgFileToGroup("sendDocument", "document", buf, file.filename, file.mimeType, caption);
      }
    } catch (e) {
      return { ok: false, error: "Не удалось загрузить файл" };
    }
    if (!resp || !resp.ok) {
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
    task.files = Array.isArray(task.files) ? task.files : [];
    task.files.push(fileEntry);
    fileIndex = task.files.length - 1;
  }

  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    from: fromClient ? "client" : "staff",
    by: actor || (fromClient ? task.company || "Клиент" : "CRM"),
    text: cleanText || null,
    fileIndex,
  };

  task.thread = Array.isArray(task.thread) ? task.thread : [];
  task.thread.push(entry);
  if (task.thread.length > 200) task.thread = task.thread.slice(-200);
  task.updatedAt = new Date().toISOString();
  await redis.set("task:" + task.num, task);
  await logEvent("crm", "task_message_sent", { num: task.num, by: entry.by, from: entry.from, file: fileIndex !== null });
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
    .filter((t) => t.dueDate && t.status !== "done" && t.status !== "cancelled")
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
/* Компания по умолчанию для напоминаний без конкретного клиента ("Все
   клиенты") — Task обязательно должна быть привязана к компании. */


function addDaysStr(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function advanceDateStr(dateStr, repeat) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (repeat === "monthly") dt.setUTCMonth(dt.getUTCMonth() + 1);
  else if (repeat === "quarterly") dt.setUTCMonth(dt.getUTCMonth() + 3);
  else if (repeat === "yearly") dt.setUTCFullYear(dt.getUTCFullYear() + 1);
  else return null;
  return dt.toISOString().slice(0, 10);
}

/* "Живой" листенер: вместо того чтобы полностью зависеть от внешнего
   крона (api/cron/reminders.js всё ещё существует как подстраховка, но
   раз в сутки/несколько часов — этого мало), при каждом обращении к
   задачам или календарю из CRM заодно проверяем, не наступило ли окно
   напоминания у активных событий календаря. Если да — сразу заводим
   задачу (статус "Новая", без исполнителя) и отправляем карточку в
   группу, не дожидаясь тика крона. Идемпотентно: ev.taskCreatedFor
   гарантирует ровно одну задачу на цикл события, сколько бы раз ни
   сработала проверка. Отдельного "предварительного" сообщения-звоночка
   больше нет — сама созданная задача (с карточкой в группе) и есть
   уведомление. */
async function ensureDueReminderTasks() {
  try {
    /* ensureDueReminderTasks() запускается на каждый GET r=tasks /
       r=calendar_events — с учётом live-поллинга на фронте (раз в 7с на
       вкладку) это может означать десятки вызовов в минуту при нескольких
       открытых вкладках, хотя события календаря меняются редко. Простой
       SETNX-guard с коротким TTL ограничивает реальную работу (чтение +
       разбор всех событий) одним разом за FRESHNESS_SEC, вне зависимости
       от того, сколько запросов пришло за это время. */
    const FRESHNESS_SEC = 20;
    const fresh = await redis.set("reminderscheck:guard", "1", { nx: true, ex: FRESHNESS_SEC });
    if (!fresh) return;

    const ids = (await redis.smembers("calendarevents")) || [];
    if (!ids.length) return;
    const keys = ids.map((id) => "calendarevent:" + id);
    const rows = (await redis.mget(...keys)).filter(Boolean).filter((e) => e.active !== false);
    if (!rows.length) return;

    const todayStr = tashkentDateStr();

    for (const ev of rows) {
      const remindFrom = addDaysStr(ev.date, -(ev.remindDays || 0));
      const due = todayStr >= remindFrom;
      let changed = false;

      if (due && ev.taskCreatedFor !== ev.date) {
        /* ensureDueReminderTasks() запускается на каждый GET r=tasks /
           r=calendar_events — если CRM открыта в двух вкладках или два
           запроса пришли почти одновременно, оба могли прочитать
           ev.taskCreatedFor как "ещё не создано" ДО того, как первый
           успеет дозаписать redis (между чтением и записью проходит
           обращение к Telegram API — сотни мс, этого достаточно для
           гонки). Из-за этого одно и то же напоминание дублировалось в
           задачах. Лок на основе SETNX гарантирует, что задачу создаст
           только один из параллельных запросов. */
        const lockKey = `reminderlock:${ev.id}:${ev.date}`;
        const acquired = await redis.set(lockKey, "1", { nx: true, ex: 60 });
        if (acquired) try {
          /* Напоминания — отдельный тип задач без company ("Все клиенты"
             тоже не привязаны к конкретной компании). Это осознанное
             решение: напоминание не про конкретного клиента. */
          const evCompany = ev.company || null;
          const n = await redis.incr("counter:task");
          const num = 100 + n;
          const label = ev.type === "tax" ? "Налог/отчёт" : "Платёж";
          const task = {
            num, client: null, company: evCompany,
            text: `${label}: ${ev.title} (срок ${ev.date})`,
            files: [], status: "new", assignee: null,
            createdAt: new Date().toISOString(), source: "crm",
            dueDate: ev.date, fromCalendarEvent: ev.id, type: "reminder",
          };
          if (evCompany) {
            try {
              const clientId = await redis.get("clientcompany:" + normCompany(evCompany));
              if (clientId) {
                const cl = await redis.get("client:" + clientId);
                if (cl && cl.telegramId) task.client = cl.telegramId;
              }
            } catch (e2) { /* клиента не нашли — задача создаётся без привязки к Telegram-аккаунту */ }
          }

          await redis.set("task:" + num, task);
          await redis.sadd("tasks:withdue", num);
          if (task.client) {
            await redis.lpush("utasks:" + task.client, num);
            await redis.ltrim("utasks:" + task.client, 0, 19);
          }

          try {
            const header =
              `🔔 <b>Напоминание №${num}</b> · ⚪️ Новая` +
              (evCompany ? `\n🏢 <b>${escapeHtml(evCompany)}</b>` : "") +
              `\n━━━━━━━━━━━━\n` +
              `<b>${escapeHtml(task.text)}</b>\n\n👉 <i>Исполнитель и статус — в CRM</i>`;
            const sent = await tgToGroup("sendMessage", { text: header, parse_mode: "HTML" });
            if (sent && sent.ok && sent.result && sent.result.message_id) {
              task.gmsg = sent.result.message_id;
              await redis.set("task:" + num, task);
            }
          } catch (e2) { /* карточка не критична для самого создания задачи */ }

          ev.taskCreatedFor = ev.date;
          changed = true;
          await logEvent("crm", "task_created_from_reminder", { num, eventId: ev.id, company: evCompany, dueDate: ev.date });
        } catch (e2) { /* задача не критична для самого напоминания */ }
      }

      if (todayStr > ev.date) {
        const next = advanceDateStr(ev.date, ev.repeat);
        if (next) {
          ev.date = next;
          ev.taskCreatedFor = null;
        } else {
          ev.active = false;
        }
        changed = true;
      }

      if (changed) {
        try { await redis.set("calendarevent:" + ev.id, ev); } catch (e2) { /* noop */ }
      }
    }
  } catch (e) {
    console.error("ensureDueReminderTasks:", e);
  }
}


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
    active: true, lastNotifiedDate: null,
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

const STATUS_RU_LABELS = { new: "Новая", in_progress: "В работе", done: "Выполнена", cancelled: "Отменена" };

async function updateStatus(num, status, assignee) {
  const task = await redis.get("task:" + num);
  if (!task) return { ok: false, error: "task not found" };
  const prev = task.status;
  task.status = status;
  if (status === "in_progress") task.assignee = assignee || task.assignee || "CRM";
  if (status === "done") task.doneAt = new Date().toISOString();
  else if (prev === "done" && status !== "done") task.doneAt = null; // вернули в работу — снимаем метку архивации

  /* Автоматическая запись в ленту задачи, когда статус меняет ИИ (assignee ===
     "AI-бухгалтер") — независимо от того, какой конкретно код это вызвал
     (автономный auto_work, /ask в группе, AI-чат в CRM). Раньше запись в
     ленту (pushThreadEntry) делали только reportExecSuccess/reportExecBlocked
     внутри runAutoWork, поэтому задачи, которые ИИ обрабатывал через обычный
     agent-чат (без прохождения через auto_work), оставались с пустой лентой —
     это и было причиной "пропавшей" истории. Логируем здесь, в одном месте,
     через которое проходят вообще все изменения статуса, чтобы лента больше
     никогда не оставалась пустой независимо от пути вызова. */
  if (prev !== status && assignee === "AI-бухгалтер") {
    task.thread = Array.isArray(task.thread) ? task.thread : [];
    task.thread.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      from: "staff",
      by: "AI-бухгалтер",
      text: `🤖 Статус изменён: «${STATUS_RU_LABELS[prev] || prev}» → «${STATUS_RU_LABELS[status] || status}»`,
      fileIndex: null,
    });
    if (task.thread.length > 200) task.thread = task.thread.slice(-200);
  }

  await redis.set("task:" + num, task);
  await logEvent("crm", "status_changed", {
    num, from: prev, to: status,
    assignee: task.assignee || null, by: assignee || "CRM",
  });

  /* Обновление карточки в группе и уведомление клиента — независимые
     похода в Telegram, отправляем параллельно вместо последовательного
     ожидания. */
  const groupPromise = task.gmsg
    ? (() => {
        const catLine = task.category ? `🗂 ${escapeHtml(task.category)}${task.sub ? " · " + escapeHtml(task.sub) : ""}\n` : "";
        const header =
          `🆕 <b>Задача №${num}</b> · ${STATUS_TOP[status] || status}\n` +
          `🏢 <b>${escapeHtml(task.company || "—")}</b>\n` + catLine + `━━━━━━━━━━━━\n` +
          `<b>${escapeHtml(String(task.text).slice(0, 3600))}</b>` +
          (task.files && task.files.length ? `\n\n📎 Вложений: ${task.files.length}` : "") +
          (task.assignee && status !== "new" ? `\n👩‍💼 <b>Исполнитель:</b> ${escapeHtml(task.assignee)}` : "") +
          (status === "new" ? `\n👉 <i>Исполнитель и статус — в CRM</i>` : "");
        return tgToGroup("editMessageText", { message_id: task.gmsg, text: header, parse_mode: "HTML" }).catch(() => null);
      })()
    : Promise.resolve(null);

  const clientPromise = (task.client && prev !== status)
    ? (async () => {
        // "Новая задача назначена мне" — если выключено, не шлём клиенту
        // личное сообщение именно про назначение (остальные статусы шлём как обычно).
        if (status === "in_progress") {
          const ns = (await redis.get("notif:settings")) || {};
          if (ns.taskAssigned === false) return null;
        }
        try {
          const u = await redis.get("user:" + task.client);
          const m = MSG[(u && u.lang) || "ru"];
          const text =
            status === "done" ? m.done(num)
            : status === "cancelled" ? m.cancelled(num)
            : status === "in_progress" ? m.assigned(num, task.assignee || "бухгалтер")
            : m.reopened(num);
          return await tg("sendMessage", { chat_id: task.client, text });
        } catch (e) { return null; }
      })()
    : Promise.resolve(null);

  await Promise.all([groupPromise, clientPromise]);

  return { ok: true, task: safeTask(task) };
}



/* ---------------- Тарифы: лимит операций в месяц + сверхлимит ----------------
   «Операция» = выполненная задача клиента за календарный месяц.
   Тарифы настраиваются в CRM (Настройки → Тарифы) и хранятся в Redis. */
const DEFAULT_TARIFFS = [
  { id: "standard", name: "Стандарт", price: 1500000, monthlyLimit: 30, overPackOps: 10, overPackPrice: 400000 },
  { id: "extended", name: "Расширенный", price: 3000000, monthlyLimit: 80, overPackOps: 20, overPackPrice: 600000 },
  { id: "premium", name: "Премиум", price: 6000000, monthlyLimit: null, overPackOps: null, overPackPrice: null },
];

async function getTariffs() {
  try {
    const t = await redis.get("tariffs");
    if (Array.isArray(t) && t.length) return t;
  } catch (e) { /* noop */ }
  return DEFAULT_TARIFFS;
}

/* Сколько операций у клиента в этом месяце: выполненные задачи + купленные
   пакеты сверхлимита (ops:extra) учитываются в лимите. */
async function clientUsage(client, tasks, tariffs) {
  const ym = new Date().toISOString().slice(0, 7);
  const normC = normCompany(client.company || "");
  const used = tasks.filter((t) =>
    t.status === "done" &&
    normCompany(t.company || "") === normC &&
    String(t.createdAt || "").slice(0, 7) === ym
  ).length;
  const tariff = tariffs.find((t) => t.name === client.tariff || t.id === client.tariff) || null;
  let extraPacks = 0;
  try { extraPacks = Number((await redis.get(`opspacks:${client.id}:${ym}`)) || 0); } catch (e) { /* noop */ }
  const baseLimit = tariff && tariff.monthlyLimit != null ? tariff.monthlyLimit : null;
  const limit = baseLimit == null ? null : baseLimit + extraPacks * (tariff.overPackOps || 0);
  return {
    used,
    limit,
    baseLimit,
    extraPacks,
    tariffName: tariff ? tariff.name : client.tariff || null,
    over: limit != null && used > limit,
  };
}

/* ---------------- Заявки на доступ (конфликты телефонов/аккаунтов из бота) ---------------- */
async function listAccessRequests() {
  const rows = (await redis.lrange("access_requests", 0, 49)) || [];
  return rows.map((r) => { try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } }).filter(Boolean);
}

async function resolveAccessRequest(id, approve, actor) {
  const rows = (await redis.lrange("access_requests", 0, 49)) || [];
  let idx = -1, reqObj = null;
  rows.forEach((r, i) => {
    try {
      const o = typeof r === "string" ? JSON.parse(r) : r;
      if (o && o.id === id) { idx = i; reqObj = o; }
    } catch (e) { /* noop */ }
  });
  if (!reqObj) return { ok: false, error: "request not found" };
  if (reqObj.status !== "pending") return { ok: false, error: "already resolved" };

  let issuedPassword = null;
  if (approve) {
    if (reqObj.type === "member_approve") {
      const u = await redis.get("user:" + reqObj.telegramId);
      if (!u) return { ok: false, error: "bot user not found" };
      u.clientRole = "trusted-member";
      u.approvalRequested = false;
      await redis.set("user:" + reqObj.telegramId, u);
      await tg("sendMessage", { chat_id: reqObj.telegramId, text: "✅ Вам разрешили отправлять заявки от компании «" + (reqObj.company || "") + "». Добро пожаловать!" });
    } else if (reqObj.type === "telegram_rebind") {
      const client = reqObj.clientId ? await redis.get("client:" + reqObj.clientId) : null;
      if (!client) return { ok: false, error: "client card not found" };
      client.telegramId = reqObj.telegramId;
      client.updatedAt = new Date().toISOString();
      await redis.set("client:" + reqObj.clientId, client);
      await tg("sendMessage", { chat_id: reqObj.telegramId, text: "✅ Бухгалтерия подтвердила ваш аккаунт. Уведомления по задачам «" + (reqObj.company || "") + "» снова приходят сюда." });
    } else {
      const u = await redis.get("user:" + reqObj.telegramId);
      if (!u) return { ok: false, error: "bot user not found" };
      const phone = normPhone(reqObj.claimedPhone || u.phone || "");
      if (!phone) return { ok: false, error: "no phone in request" };
      issuedPassword = genPassword();
      u.pwdHash = bcrypt.hashSync(issuedPassword, 10);
      u.pwdPlain = issuedPassword;
      u.authPhone = phone;
      await redis.set("user:" + reqObj.telegramId, u);
      await redis.set("authphone:" + phone, reqObj.telegramId);
      const site = process.env.CRM_APP_URL || "https://finpulse-crm-app.vercel.app";
      await tg("sendMessage", {
        chat_id: reqObj.telegramId,
        parse_mode: "HTML",
        text: "✅ Бухгалтерия подтвердила ваш доступ.\n\n🔐 <b>Личный кабинет CRM</b>\nСайт: " + site +
          "\nЛогин (телефон): <code>" + phone + "</code>\nПароль: <code>" + issuedPassword + "</code>\n\nЭтот доступ всегда можно посмотреть командой /help.",
      });
    }
  } else {
    if (reqObj.type === "member_approve") {
      try {
        const u = await redis.get("user:" + reqObj.telegramId);
        if (u) { u.clientRole = "rejected"; u.approvalRequested = false; await redis.set("user:" + reqObj.telegramId, u); }
      } catch (e) { /* noop */ }
    }
    try {
      await tg("sendMessage", { chat_id: reqObj.telegramId, text: "❌ Бухгалтерия не подтвердила доступ по компании «" + (reqObj.company || "") + "». Если это ошибка — свяжитесь с вашим бухгалтером." });
    } catch (e) { /* noop */ }
  }

  reqObj.status = approve ? "approved" : "rejected";
  reqObj.resolvedAt = new Date().toISOString();
  reqObj.resolvedBy = actor || "CRM";
  await redis.lset("access_requests", idx, JSON.stringify(reqObj));
  await logEvent("crm", approve ? "access_request_approved" : "access_request_rejected", {
    requestId: id, type: reqObj.type, company: reqObj.company || null, by: actor || "CRM",
  });
  return { ok: true, request: reqObj };
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
        await ensureDueReminderTasks();
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
      if (q.r === "logs_archive") {
        /* Помесячный архив (см. logEvent) — глубже, чем последние 500
           живых записей. Месяц по умолчанию — текущий, можно указать
           month=YYYY-MM для более старых периодов. */
        if (!isStaff) return res.status(403).json({ ok: false, error: "forbidden" });
        const src = q.src === "crm" ? "crm" : "telegram";
        const month = /^\d{4}-\d{2}$/.test(String(q.month || "")) ? q.month : new Date().toISOString().slice(0, 7);
        const rows = (await redis.lrange("logs:archive:" + src + ":" + month, 0, 9999)) || [];
        const logs = rows.map((r) => { try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } }).filter(Boolean);
        return res.status(200).json({ ok: true, src, month, count: logs.length, logs });
      }
      if (q.r === "bot_settings") {
        if (!isStaff) return res.status(403).json({ ok: false, error: "forbidden" });
        const def = { slaHours: 3, workStart: 9, workEnd: 16, tzOffset: 5 };
        const cur = (await redis.get("bot:settings")) || {};
        return res.status(200).json({ ok: true, settings: { ...def, ...cur } });
      }
      if (q.r === "bot_positions") {
        if (!isStaff) return res.status(403).json({ ok: false, error: "forbidden" });
        const def = ["👑 Директор", "💼 Владелец", "📚 Главный бухгалтер", "🧾 Бухгалтер", "📋 Менеджер"];
        const cur = (await redis.get("bot:positions")) || null;
        return res.status(200).json({ ok: true, positions: Array.isArray(cur) && cur.length ? cur : def });
      }
      if (q.r === "bot_categories") {
        if (!isStaff) return res.status(403).json({ ok: false, error: "forbidden" });
        const cats = (await redis.get("bot:categories")) || null;
        return res.status(200).json({ ok: true, categories: Array.isArray(cats) && cats.length ? cats : DEFAULT_CATEGORIES });
      }
      if (q.r === "notif_settings") {
        if (!isStaff) return res.status(403).json({ ok: false, error: "forbidden" });
        const def = { taskAssigned: true, clientMessage: true, dueSoon: true, overdue: true, weeklyDigest: false };
        const cur = (await redis.get("notif:settings")) || {};
        return res.status(200).json({ ok: true, settings: { ...def, ...cur } });
      }
      if (q.r === "tariffs") {
        return res.status(200).json({ ok: true, tariffs: await getTariffs() });
      }
      if (q.r === "assign_rules") {
        if (!isStaff) return res.status(403).json({ ok: false, error: "forbidden" });
        return res.status(200).json({ ok: true, rules: await getAssignRules(redis) });
      }
      if (q.r === "dicts") {
        if (!isStaff) return res.status(403).json({ ok: false, error: "forbidden" });
        const def = {
          calendarEventTypes: ["Налоги и отчёты", "Платежи фирм", "Задачи"],
          paymentCategories: ["Аренда", "Интернет и связь", "Коммунальные услуги", "Лизинг", "Страховка"],
          taxCategories: ["Оплата НДС", "Аванс по УСН", "НДФЛ и соцвзносы", "Отчёт в статистику"],
          reminderIntervals: ["В день события", "За 1 день", "За 3 дня", "За неделю"],
          repeatPeriods: ["Однократно", "Ежедневно", "Ежемесячно", "Ежеквартально", "Ежегодно"],
          reminderTypeLabels: { tax: "Налог / отчёт", pay: "Платёж фирмы" },
        };
        const cur = (await redis.get("dicts:custom")) || {};
        return res.status(200).json({ ok: true, dicts: { ...def, ...cur } });
      }
      if (q.r === "usage") {
        if (!isStaff) return res.status(403).json({ ok: false, error: "forbidden" });
        const [all, tasksAll, tariffs] = await Promise.all([listClients(), listTasks(), getTariffs()]);
        const usage = {};
        for (const c of all) usage[c.id] = await clientUsage(c, tasksAll, tariffs);
        return res.status(200).json({ ok: true, usage });
      }
      if (q.r === "access_requests") {
        if (!isStaff) return res.status(403).json({ ok: false, error: "forbidden" });
        return res.status(200).json({ ok: true, requests: await listAccessRequests() });
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
        /* Гостю отдаём демо-карточку без похода в Redis вообще — иначе
           ответ 200(demo)/404(not found) превращается в оракул "существует
           ли такой id" для неаутентифицированного/демо-доступа. */
        if (rolesEnforced && authUser.role === "guest") {
          return res.status(200).json({ ok: true, client: DEMO_CLIENT });
        }
        const c = await redis.get("client:" + q.id);
        if (!c) return res.status(404).json({ ok: false, error: "not found" });
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
        await ensureDueReminderTasks();
        let events = (await listCalendarEvents()).map(safeCalendarEvent);
        if (rolesEnforced && authUser.role === "client") {
          events = events.filter((e) => !e.company || normCompany(e.company) === normCompany(authUser.company || ""));
        }
        return res.status(200).json({ ok: true, events });
      }
      return res.status(200).json({ ok: true, service: "Finpulse CRM API", routes: ["ping", "tasks", "logs", "pending", "clients", "client", "calendar", "calendar_events", "employees", "tariffs", "dicts", "notif_settings", "bot_settings", "bot_categories", "bot_positions", "assign_rules"] });
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

      if (body && body.action === "notif_settings_save" && body.settings) {
        const isAdmin = !rolesEnforced || (authUser && authUser.role === "admin");
        if (!isAdmin) return res.status(403).json({ ok: false, error: "admin only" });
        const b = body.settings;
        const clean = {
          taskAssigned: !!b.taskAssigned,
          clientMessage: !!b.clientMessage,
          dueSoon: !!b.dueSoon,
          overdue: !!b.overdue,
          weeklyDigest: !!b.weeklyDigest,
        };
        await redis.set("notif:settings", clean);
        await logEvent("crm", "notif_settings_updated", { ...clean, by: (authUser && authUser.name) || "CRM" });
        return res.status(200).json({ ok: true, settings: clean });
      }
      if (body && body.action === "bot_settings_save" && body.settings) {
        const isAdmin = !rolesEnforced || (authUser && authUser.role === "admin");
        if (!isAdmin) return res.status(403).json({ ok: false, error: "admin only" });
        const b = body.settings;
        const clean = {
          slaHours: Math.min(72, Math.max(1, Number(b.slaHours) || 3)),
          workStart: Math.min(23, Math.max(0, Number(b.workStart) || 9)),
          workEnd: Math.min(24, Math.max(1, Number(b.workEnd) || 16)),
          tzOffset: 5,
        };
        if (clean.workEnd <= clean.workStart) return res.status(200).json({ ok: false, error: "конец окна должен быть позже начала" });
        await redis.set("bot:settings", clean);
        await logEvent("crm", "bot_settings_updated", { ...clean, by: (authUser && authUser.name) || "CRM" });
        return res.status(200).json({ ok: true, settings: clean });
      }
      if (body && body.action === "bot_positions_save" && Array.isArray(body.positions)) {
        const isAdmin = !rolesEnforced || (authUser && authUser.role === "admin");
        if (!isAdmin) return res.status(403).json({ ok: false, error: "admin only" });
        const clean = body.positions.map((x) => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, 15);
        if (!clean.length) return res.status(200).json({ ok: false, error: "нужна хотя бы одна должность" });
        await redis.set("bot:positions", clean);
        await logEvent("crm", "bot_positions_updated", { count: clean.length, by: (authUser && authUser.name) || "CRM" });
        return res.status(200).json({ ok: true, positions: clean });
      }
      if (body && body.action === "bot_categories_save" && Array.isArray(body.categories)) {
        const isAdmin = !rolesEnforced || (authUser && authUser.role === "admin");
        if (!isAdmin) return res.status(403).json({ ok: false, error: "admin only" });
        const clean = body.categories
          .filter((c) => c && c.name)
          .slice(0, 15)
          .map((c, i) => ({
            id: String(c.id || "cat" + i).slice(0, 20),
            name: String(c.name).slice(0, 50),
            subs: Array.isArray(c.subs) ? c.subs.map((x) => String(x).slice(0, 60)).filter(Boolean).slice(0, 10) : [],
          }));
        await redis.set("bot:categories", clean);
        await logEvent("crm", "bot_categories_updated", { count: clean.length, by: (authUser && authUser.name) || "CRM" });
        return res.status(200).json({ ok: true, categories: clean });
      }
      if (body && body.action === "tariffs_save" && Array.isArray(body.tariffs)) {
        const isAdmin = !rolesEnforced || (authUser && authUser.role === "admin");
        if (!isAdmin) return res.status(403).json({ ok: false, error: "admin only" });
        const clean = body.tariffs
          .filter((t) => t && t.name)
          .slice(0, 20)
          .map((t, i) => ({
            id: String(t.id || "t" + i),
            name: String(t.name).slice(0, 60),
            price: t.price == null ? null : Number(t.price) || 0,
            monthlyLimit: t.monthlyLimit == null || t.monthlyLimit === "" ? null : Math.max(0, Number(t.monthlyLimit) || 0),
            overPackOps: t.overPackOps == null || t.overPackOps === "" ? null : Math.max(0, Number(t.overPackOps) || 0),
            overPackPrice: t.overPackPrice == null || t.overPackPrice === "" ? null : Number(t.overPackPrice) || 0,
          }));
        await redis.set("tariffs", clean);
        await logEvent("crm", "tariffs_updated", { count: clean.length, by: (authUser && authUser.name) || "CRM" });
        return res.status(200).json({ ok: true, tariffs: clean });
      }
      if (body && body.action === "assign_rules_save" && Array.isArray(body.rules)) {
        const isAdmin = !rolesEnforced || (authUser && authUser.role === "admin");
        if (!isAdmin) return res.status(403).json({ ok: false, error: "admin only" });
        const clean = await saveAssignRules(redis, body.rules);
        await logEvent("crm", "assign_rules_updated", { count: clean.length, by: (authUser && authUser.name) || "CRM" });
        return res.status(200).json({ ok: true, rules: clean });
      }
      if (body && body.action === "dicts_save" && body.dicts) {
        const isAdmin = !rolesEnforced || (authUser && authUser.role === "admin");
        if (!isAdmin) return res.status(403).json({ ok: false, error: "admin only" });
        const d = body.dicts;
        const cleanList = (arr, max) =>
          Array.isArray(arr) ? arr.map((x) => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, max) : [];
        const cleanLabel = (v, fallback) => (v && String(v).trim() ? String(v).trim().slice(0, 40) : fallback);
        const clean = {
          calendarEventTypes: cleanList(d.calendarEventTypes, 20),
          paymentCategories: cleanList(d.paymentCategories, 30),
          taxCategories: cleanList(d.taxCategories, 30),
          reminderIntervals: cleanList(d.reminderIntervals, 15),
          repeatPeriods: cleanList(d.repeatPeriods, 10),
          reminderTypeLabels: {
            tax: cleanLabel(d.reminderTypeLabels && d.reminderTypeLabels.tax, "Налог / отчёт"),
            pay: cleanLabel(d.reminderTypeLabels && d.reminderTypeLabels.pay, "Платёж фирмы"),
          },
        };
        await redis.set("dicts:custom", clean);
        await logEvent("crm", "dicts_updated", { by: (authUser && authUser.name) || "CRM" });
        return res.status(200).json({ ok: true, dicts: clean });
      }
      if (body && body.action === "ops_pack_add" && body.clientId) {
        if (!isStaff) return res.status(403).json({ ok: false, error: "forbidden" });
        const ym = new Date().toISOString().slice(0, 7);
        const n = await redis.incrby(`opspacks:${body.clientId}:${ym}`, Math.max(1, Number(body.packs) || 1));
        await redis.expire(`opspacks:${body.clientId}:${ym}`, 60 * 60 * 24 * 62);
        await logEvent("crm", "ops_pack_added", { clientId: body.clientId, month: ym, packs: n, by: (authUser && authUser.name) || "CRM" });
        return res.status(200).json({ ok: true, packs: n });
      }
      if (body && body.action === "access_request_resolve" && body.id) {
        if (!isStaff) return res.status(403).json({ ok: false, error: "forbidden" });
        const r = await resolveAccessRequest(String(body.id), !!body.approve, authUser?.name || "CRM");
        return res.status(200).json(r);
      }
      if (body && body.action === "status" && body.num && body.status) {
        if (!isStaff) return res.status(403).json({ ok: false, error: "forbidden" });
        if (!["new", "in_progress", "done", "cancelled"].includes(body.status)) {
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
        const patch = { ...(body.patch || {}) };
        /* Телефон компании — ключ привязки к Telegram и логин кабинета:
           менять может только супер-админ, с переносом индекса. */
        if (Object.prototype.hasOwnProperty.call(patch, "phone")) {
          const isAdmin = !rolesEnforced || (authUser && authUser.role === "admin");
          if (!isAdmin) return res.status(403).json({ ok: false, error: "телефон компании меняет только супер-админ" });
          const c = await redis.get("client:" + body.id);
          if (!c) return res.status(200).json({ ok: false, error: "client not found" });
          const newP = patch.phone ? normPhone(patch.phone) : null;
          const oldP = c.phone ? normPhone(c.phone) : null;
          if (newP !== oldP) {
            if (newP) {
              const takenBy = await redis.get("clientphone:" + newP);
              if (takenBy && takenBy !== body.id) return res.status(200).json({ ok: false, error: "этот телефон уже привязан к другой карточке" });
            }
            if (oldP && (await redis.get("clientphone:" + oldP)) === body.id) await redis.del("clientphone:" + oldP);
            if (newP) await redis.set("clientphone:" + newP, body.id);
            c.phone = newP;
            c.updatedAt = new Date().toISOString();
            await redis.set("client:" + body.id, c);
            await logEvent("crm", "client_phone_changed", { id: body.id, by: actor });
          }
          delete patch.phone;
        }
        const r = await patchClient(body.id, patch, actor);
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
      if (body && body.action === "task_message_send" && body.num) {
        if (!isStaff && !isClient && !isGuest) return res.status(403).json({ ok: false, error: "forbidden" });
        if (isGuest) {
          return res.status(200).json({ ok: true, demo: true });
        }
        const task = await redis.get("task:" + Number(body.num));
        if (!task) return res.status(200).json({ ok: false, error: "task not found" });
        if (isClient && normCompany(task.company) !== normCompany(authUser.company || "")) {
          return res.status(403).json({ ok: false, error: "forbidden" });
        }
        const actor = (authUser && authUser.name) || (isClient ? task.company : "CRM");
        const file = body.dataBase64
          ? { filename: body.filename, mimeType: body.mimeType, dataBase64: body.dataBase64 }
          : null;
        const r = await sendTaskMessage(task, body.text, actor, isClient, file);
        /* Если ИИ-бухгалтер сейчас ждёт уточнения по этой задаче (см.
           askClarificationInGroup/aiq_task в api/ai.js) — сообщение
           бухгалтера в чате CRM тоже должно "докормить" автономный
           конвейер, а не только реплай в Telegram-группе. Реагируем
           только на сообщения от бухгалтера/админа (не от клиента), и
           только если это обычный текст (не файл-only). */
        if (isStaff && !isClient && typeof body.text === "string" && body.text.trim()) {
          try {
            const aiq = await redis.get("aiq_task:" + Number(body.num));
            if (aiq) {
              await redis.del("aiq_task:" + Number(body.num));
              triggerAutoWork(Number(body.num), body.text.trim(), { kind: aiq.kind || "generic", suggestions: aiq.suggestions || [] });
            }
          } catch (e) { console.error("crm chat aiq resume:", body.num, String(e).slice(0, 200)); }
        }
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
