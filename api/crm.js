/* ============================================================
   Finpulse CRM — API-мост между веб-CRM и Telegram-ботом.
   Читает те же ключи Upstash Redis, что и api/bot.js.

   GET  /api/crm?r=ping     → проверка связи (кол-во задач, группа)
   GET  /api/crm?r=tasks    → последние задачи из бота (без личных данных)
   GET  /api/crm?r=logs&src=telegram|crm → журнал событий
   GET  /api/crm?r=pending  → компании из бота, ждущие активации
   POST /api/crm {action:"status", num, status, assignee}
        → смена статуса: Redis + карточка в группе + уведомление клиента
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
  };
}

function maskPhone(p) {
  if (!p) return null;
  return String(p).replace(/(\+?\d{3})\d+(\d{2})$/, "$1 *** ** $2");
}

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
        (task.assignee && status !== "new" ? `\n👩‍💼 Исполнитель: ${task.assignee}` : "");
      const kb =
        status === "new"
          ? { inline_keyboard: [[{ text: "🙋 Взять в работу", callback_data: `take:${num}` }, { text: "✅ Выполнена", callback_data: `done:${num}` }]] }
          : status === "in_progress"
            ? { inline_keyboard: [[{ text: "✅ Выполнена", callback_data: `done:${num}` }]] }
            : { inline_keyboard: [] };
      await tg("editMessageText", { chat_id: Number(group), message_id: task.gmsg, text: header, reply_markup: kb });
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
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-api-key");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (!checkApiKey(req)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    if (req.method === "GET") {
      const q = req.query || {};
      if (q.r === "ping") {
        const [n, group] = await Promise.all([redis.get("counter:task"), redis.get("group")]);
        return res.status(200).json({ ok: true, tasks: Number(n || 0), group: !!group, bot: "@finpulse_crm_bot" });
      }
      if (q.r === "tasks") {
        return res.status(200).json({ ok: true, tasks: await listTasks() });
      }
      if (q.r === "logs") {
        const src = q.src === "crm" ? "crm" : "telegram";
        const rows = (await redis.lrange("logs:" + src, 0, 199)) || [];
        const logs = rows.map((r) => { try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } }).filter(Boolean);
        return res.status(200).json({ ok: true, src, logs });
      }
      if (q.r === "pending") {
        const rows = (await redis.lrange("pending_clients", 0, 49)) || [];
        const pending = rows.map((r) => { try { const o = typeof r === "string" ? JSON.parse(r) : r; return { company: o.company, phone: maskPhone(o.phone), at: o.at || o.ts || null }; } catch { return null; } }).filter(Boolean);
        return res.status(200).json({ ok: true, pending });
      }
      return res.status(200).json({ ok: true, service: "Finpulse CRM API", routes: ["ping", "tasks", "logs", "pending"] });
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
      if (body && body.action === "status" && body.num && body.status) {
        if (!["new", "in_progress", "done"].includes(body.status)) {
          return res.status(200).json({ ok: false, error: "bad status" });
        }
        const r = await updateStatus(Number(body.num), body.status, body.assignee);
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
