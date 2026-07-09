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
   ============================================================ */

const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

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
  { num: 9001, company: "Демо ООО «Пример»", text: "Подготовить отчёт по НДС", status: "in_progress", assignee: "Демо-бухгалтер", createdAt: new Date().toISOString(), files: 1 },
  { num: 9002, company: "Демо ООО «Пример»", text: "Свериться с поставщиком", status: "new", assignee: null, createdAt: new Date().toISOString(), files: 0 },
  { num: 9003, company: "Демо ООО «Пример»", text: "Начислить зарплату за месяц", status: "done", assignee: "Демо-бухгалтер", createdAt: new Date().toISOString(), files: 2 },
];
const tg = (method, payload) =>
  fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => r.json()).catch(() => null);

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
    dueDate: t.dueDate || null,
    source: t.source === "crm" ? "crm" : "bot",
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
    const group = await redis.get("group");
    if (group) await tg("sendMessage", { chat_id: Number(group), text });
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
  const allowed = ["status", "assignedTo", "tariff", "note", "position"];
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
  const cleanText = String(text || "").trim();
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
    const group = await redis.get("group");
    if (group) {
      const header =
        `🆕 Задача №${num}\n🏢 Компания: ${finalCompany}\n——————————\n` +
        `${cleanText.slice(0, 3600)}\n\n` +
        `${STATUS_LINE[task.status] || task.status}` +
        (task.assignee ? `\n👩‍💼 Исполнитель: ${task.assignee}` : "") +
        `\n✍️ Заведена из CRM: ${actor || "CRM"}` +
        (task.status === "new" ? `\n👉 Назначьте исполнителя и статус — в CRM.` : "");
      const sent = await tg("sendMessage", { chat_id: Number(group), text: header });
      if (sent && sent.result && sent.result.message_id) {
        task.gmsg = sent.result.message_id;
        await redis.set("task:" + num, task);
      }
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
    if (Object.prototype.hasOwnProperty.call(patch || {}, k)) task[k] = patch[k];
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
  await redis.set("task:" + num, task);
  await logEvent("crm", "status_changed", {
    num, from: prev, to: status,
    assignee: task.assignee || null, by: assignee || "CRM",
  });

  /* Обновляем карточку в группе бухгалтеров */
  try {
    const group = await redis.get("group");
    if (group && task.gmsg) {
      const header =
        `🆕 Задача №${num}\n🏢 Компания: ${task.company}\n——————————\n` +
        `${String(task.text).slice(0, 3600)}` +
        (task.files && task.files.length ? `\n📎 Вложений: ${task.files.length}` : "") +
        `\n\n${STATUS_LINE[status] || status}` +
        (task.assignee && status !== "new" ? `\n👩‍💼 Исполнитель: ${task.assignee}` : "") +
        (status === "new" ? `\n👉 Назначьте исполнителя и статус — в CRM.` : "");
      await tg("editMessageText", { chat_id: Number(group), message_id: task.gmsg, text: header });
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
      return res.status(200).json({ ok: true, service: "Finpulse CRM API", routes: ["ping", "tasks", "logs", "pending", "clients", "client", "calendar"] });
    }

    if (req.method === "POST") {
      if (!isStaff) return res.status(403).json({ ok: false, error: "forbidden" });
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
      if (body && body.action === "status" && body.num && body.status) {
        if (!["new", "in_progress", "done"].includes(body.status)) {
          return res.status(200).json({ ok: false, error: "bad status" });
        }
        const r = await updateStatus(Number(body.num), body.status, body.assignee);
        return res.status(200).json(r);
      }
      if (body && body.action === "client_create") {
        const actor = (authUser && authUser.name) || "CRM";
        const r = await upsertClientFromCrm(body, actor);
        return res.status(200).json(r);
      }
      if (body && body.action === "client_update" && body.id) {
        const actor = (authUser && authUser.name) || "CRM";
        const r = await patchClient(body.id, body.patch || {}, actor);
        return res.status(200).json(r);
      }
      if (body && body.action === "task_create") {
        const actor = (authUser && authUser.name) || "CRM";
        const r = await createTaskFromCrm(body, actor);
        return res.status(200).json(r);
      }
      if (body && body.action === "task_update" && body.num) {
        const actor = (authUser && authUser.name) || "CRM";
        const r = await patchTask(Number(body.num), body.patch || {}, actor);
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
      return res.status(200).json({ ok: false, error: "unknown action" });
    }

    res.status(405).json({ ok: false });
  } catch (e) {
    console.error("crm api:", e);
    res.status(200).json({ ok: false, error: String(e).slice(0, 300) });
  }
};
