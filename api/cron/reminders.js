/* ============================================================
   Finpulse CRM — ежедневное напоминание о сроках задач + повторяющихся
   событиях календаря (налоги/платежи).
   Вызывается Vercel Cron (см. vercel.json, "/api/cron/reminders").

   Что делает:
   1. Берёт все задачи с установленным dueDate (индекс "tasks:withdue"),
      которые ещё не выполнены.
      - Просроченные и те, что со сроком сегодня — собирает в один
        дайджест и отправляет в группу бухгалтеров.
      - Клиенту, у которого задача со сроком сегодня и есть telegramId,
        шлёт личное напоминание на его языке (не чаще одного раза в день
        на задачу — отмечается task.lastReminderDate).
   2. Берёт все активные события календаря (calendarevent:<id>, индекс
      "calendarevents") — это отдельная сущность, не связанная с
      задачами (налоги/платежи с повтором). Для каждого:
      - если сегодня >= (дата события − remindDays) и ещё не напоминали
        сегодня — шлёт напоминание в группу;
      - если дата события уже прошла — переносит на следующий период
        (repeat: monthly/quarterly/yearly), либо деактивирует (repeat:once).

   Защита: если задан env CRON_SECRET, запрос должен содержать
   заголовок "Authorization: Bearer <CRON_SECRET>" — именно так Vercel
   Cron подписывает свои вызовы, когда эта переменная настроена.
   Пока секрет не задан — эндпоинт открыт (rollout-safe, как и остальные
   защиты в проекте), чтобы не сломать до его настройки в Vercel.
   ============================================================ */

const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET || "";
if (!CRON_SECRET) {
  console.warn("SECURITY: CRON_SECRET не задан — эндпоинт крона открыт для любого, кто найдёт URL.");
} else if (CRON_SECRET.length < 20) {
  console.warn("SECURITY: CRON_SECRET короче 20 символов — увеличьте длину секрета.");
}

const tg = (method, payload) =>
  fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => r.json()).catch(() => null);

/* Как и в api/crm.js / api/bot.js: после апгрейда группы до супергруппы
   старый chat_id перестаёт работать — эта обёртка сама подхватывает
   parameters.migrate_to_chat_id из ответа, обновляет сохранённый id и
   повторяет запрос один раз. */
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

function normCompany(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[«»"'‘’“”.,:;()\-\u2013\u2014_/\\]/g, " ")
    .replace(/\b(ооо|оао|зао|ао|ип|чп|мчж|хк|ooo|oao|llc|ltd|inc|mchj|xk|xt)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* Оформленные (HTML, по полям) сообщения-напоминания вместо сплошного текста */
const MSG = {
  ru: (n, text, due) =>
    `⏰ <b>Напоминание</b>\n\nЗадача: №${n}\nСрок: ${due}\n\n${escapeHtml(text)}`,
  uz: (n, text, due) =>
    `⏰ <b>Eslatma</b>\n\nVazifa: №${n}\nMuddat: ${due}\n\n${escapeHtml(text)}`,
  en: (n, text, due) =>
    `⏰ <b>Reminder</b>\n\nTask: #${n}\nDue: ${due}\n\n${escapeHtml(text)}`,
};

function tashkentDateStr(d) {
  const dt = d || new Date();
  const t = new Date(dt.getTime() + 5 * 3600 * 1000);
  return t.toISOString().slice(0, 10);
}

/* "YYYY-MM-DD" + n дней (может быть отрицательным) → "YYYY-MM-DD" */
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/* Следующая дата того же события после того, как текущая прошла.
   "once" → null (повтора нет, событие деактивируется). */
function advanceDate(dateStr, repeat) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (repeat === "monthly") dt.setUTCMonth(dt.getUTCMonth() + 1);
  else if (repeat === "quarterly") dt.setUTCMonth(dt.getUTCMonth() + 3);
  else if (repeat === "yearly") dt.setUTCFullYear(dt.getUTCFullYear() + 1);
  else return null;
  return dt.toISOString().slice(0, 10);
}

async function logEvent(source, event, data) {
  try {
    await redis.lpush("logs:" + source, JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
    await redis.ltrim("logs:" + source, 0, 499);
  } catch (e) { /* noop */ }
}

async function processTaskReminders(todayStr) {
  const nums = (await redis.smembers("tasks:withdue")) || [];
  if (!nums.length) return { checked: 0, overdue: 0, dueToday: 0, notified: 0 };

  const keys = nums.map((n) => "task:" + n);
  const rows = (await redis.mget(...keys)).filter(Boolean);

  const open = rows.filter((t) => t.dueDate && t.status !== "done");
  const overdue = open.filter((t) => t.dueDate < todayStr);
  const dueToday = open.filter((t) => t.dueDate === todayStr);

  let notified = 0;

  /* Дайджест в группу */
  try {
    const group = await redis.get("group");
    if (group && (overdue.length || dueToday.length)) {
      const line = (t) =>
        `№${t.num} · ${escapeHtml(t.company)}\nСрок: ${t.dueDate}${t.assignee ? `\nИсполнитель: ${escapeHtml(t.assignee)}` : ""}`;
      let text = `⏰ <b>Напоминания на ${todayStr}</b>`;
      if (overdue.length) {
        text += `\n\n🔴 <b>Просрочено (${overdue.length})</b>\n\n` + overdue.map(line).join("\n\n");
      }
      if (dueToday.length) {
        text += `\n\n🟡 <b>Срок сегодня (${dueToday.length})</b>\n\n` + dueToday.map(line).join("\n\n");
      }
      await tg("sendMessage", { chat_id: Number(group), text, parse_mode: "HTML" });
    }
  } catch (e) { /* карточка не критична */ }

  /* Личные напоминания клиентам — только по задачам со сроком сегодня,
     не чаще раза в день на задачу */
  for (const t of dueToday) {
    if (!t.client) continue;
    if (t.lastReminderDate === todayStr) continue;
    try {
      const u = await redis.get("user:" + t.client);
      const lang = (u && u.lang) || "ru";
      await tg("sendMessage", { chat_id: t.client, text: MSG[lang](t.num, t.text, t.dueDate), parse_mode: "HTML" });
      t.lastReminderDate = todayStr;
      await redis.set("task:" + t.num, t);
      notified++;
    } catch (e) { /* noop */ }
  }

  return { checked: open.length, overdue: overdue.length, dueToday: dueToday.length, notified };
}

async function processCalendarEvents(todayStr) {
  const ids = (await redis.smembers("calendarevents")) || [];
  if (!ids.length) return { checked: 0, advanced: 0, deactivated: 0, tasksCreated: 0 };

  const keys = ids.map((id) => "calendarevent:" + id);
  const rows = (await redis.mget(...keys)).filter(Boolean).filter((e) => e.active !== false);

  let advanced = 0, deactivated = 0, tasksCreated = 0;

  /* Основной, "живой" путь создания задачи из напоминания — это
     ensureDueReminderTasks() в api/crm.js, который срабатывает при любом
     обращении к /api/crm?r=tasks|calendar_events из самого CRM (без
     зависимости от крона вообще). Этот код — лишь подстраховка на
     случай, если CRM никто не открывал: та же логика (создать задачу
     ровно один раз за цикл через ev.taskCreatedFor, затем перенести
     событие на следующий цикл повтора), продублированная здесь по тем
     же причинам, что и остальные дублирования в проекте. Отдельного
     предварительного "🔔 Напоминание"-сообщения больше нет — сама
     созданная задача с карточкой в группе и есть уведомление. */
  for (const ev of rows) {
    const remindFrom = addDays(ev.date, -(ev.remindDays || 0));
    const due = todayStr >= remindFrom;

    if (due && ev.taskCreatedFor !== ev.date) {
      /* Общий SETNX-лок с ensureDueReminderTasks() из api/crm.js — не
         даёт крону и "живому" листенеру создать дубликат, если оба
         сработают почти одновременно. */
      const lockKey = `reminderlock:${ev.id}:${ev.date}`;
      const acquired = await redis.set(lockKey, "1", { nx: true, ex: 60 });
      if (acquired) try {
        /* Напоминания — отдельный тип задач без company, как и в
           ensureDueReminderTasks() в api/crm.js. */
        const evCompany = ev.company || null;
        const n = await redis.incr("counter:task");
        const num = 100 + n;
        const label = ev.type === "tax" ? "Налог/отчёт" : "Платёж";
        const task = {
          num,
          client: null,
          company: evCompany,
          text: `${label}: ${ev.title} (срок ${ev.date})`,
          files: [],
          status: "new",
          assignee: null,
          createdAt: new Date().toISOString(),
          source: "crm",
          dueDate: ev.date,
          fromCalendarEvent: ev.id,
          type: "reminder",
        };
        if (evCompany) {
          try {
            const clientId = await redis.get("clientcompany:" + normCompany(evCompany));
            if (clientId) {
              const cl = await redis.get("client:" + clientId);
              if (cl && cl.telegramId) task.client = cl.telegramId;
            }
          } catch (e) { /* клиента не нашли — задача всё равно создаётся, просто без привязки к Telegram-аккаунту */ }
        }

        await redis.set("task:" + num, task);
        await redis.sadd("tasks:withdue", num);
        if (task.client) {
          await redis.lpush("utasks:" + task.client, num);
          await redis.ltrim("utasks:" + task.client, 0, 19);
        }

        const header =
          `🔔 Напоминание №${num}` +
          (evCompany ? `\n🏢 Компания: ${evCompany}` : "") +
          `\n——————————\n` +
          `${task.text}\n\n⚪️ Статус: Новая\n👉 Назначьте исполнителя и статус — в CRM.`;
        const sent = await tgToGroup("sendMessage", { text: header });
        if (sent && sent.ok && sent.result && sent.result.message_id) {
          task.gmsg = sent.result.message_id;
          await redis.set("task:" + num, task);
        }

        ev.taskCreatedFor = ev.date;
        tasksCreated++;
        await logEvent("cron", "task_created_from_reminder", { num, eventId: ev.id, company: evCompany, dueDate: ev.date });
      } catch (e) { /* задача не критична для самого напоминания */ }
    }

    if (todayStr > ev.date) {
      const next = advanceDate(ev.date, ev.repeat);
      if (next) {
        ev.date = next;
        ev.taskCreatedFor = null; // новый цикл повторения — задачу можно будет завести заново
        advanced++;
      } else {
        ev.active = false;
        deactivated++;
      }
    }

    try { await redis.set("calendarevent:" + ev.id, ev); } catch (e) { /* noop */ }
  }

  return { checked: rows.length, advanced, deactivated, tasksCreated };
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  if (bufA.length !== bufB.length) return false;
  try { return require("crypto").timingSafeEqual(bufA, bufB); } catch { return false; }
}

module.exports = async (req, res) => {
  if (CRON_SECRET) {
    const auth = req.headers["authorization"] || "";
    if (!timingSafeStringEqual(auth, `Bearer ${CRON_SECRET}`)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
  }

  try {
    const todayStr = tashkentDateStr();
    const [tasks, calendar] = await Promise.all([
      processTaskReminders(todayStr).catch((e) => ({ error: String(e).slice(0, 200) })),
      processCalendarEvents(todayStr).catch((e) => ({ error: String(e).slice(0, 200) })),
    ]);

    await logEvent("cron", "reminders_sent", { tasks, calendar });

    return res.status(200).json({ ok: true, tasks, calendar });
  } catch (e) {
    console.error("cron reminders:", e);
    return res.status(200).json({ ok: false, error: String(e).slice(0, 300) });
  }
};
