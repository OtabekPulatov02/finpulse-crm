/* ============================================================
   Finpulse CRM — ежедневное напоминание о сроках задач.
   Вызывается Vercel Cron (см. vercel.json, "/api/cron/reminders").

   Что делает:
   1. Берёт все задачи с установленным dueDate (индекс "tasks:withdue"),
      которые ещё не выполнены.
   2. Просроченные и те, что со сроком сегодня — собирает в один
      дайджест и отправляет в группу бухгалтеров.
   3. Клиенту, у которого задача со сроком сегодня и есть telegramId,
      шлёт личное напоминание на его языке (не чаще одного раза в день
      на задачу — отмечается task.lastReminderDate).

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

const tg = (method, payload) =>
  fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => r.json()).catch(() => null);

const MSG = {
  ru: (n, text, due) => `⏰ Напоминание: задача №${n} должна быть готова до ${due}.\n\n${text}`,
  uz: (n, text, due) => `⏰ Eslatma: №${n} vazifa ${due} sanasigacha tayyor bo'lishi kerak.\n\n${text}`,
  en: (n, text, due) => `⏰ Reminder: task #${n} is due by ${due}.\n\n${text}`,
};

function tashkentDateStr(d) {
  const dt = d || new Date();
  const t = new Date(dt.getTime() + 5 * 3600 * 1000);
  return t.toISOString().slice(0, 10);
}

async function logEvent(source, event, data) {
  try {
    await redis.lpush("logs:" + source, JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
    await redis.ltrim("logs:" + source, 0, 499);
  } catch (e) { /* noop */ }
}

module.exports = async (req, res) => {
  if (CRON_SECRET) {
    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
  }

  try {
    const nums = (await redis.smembers("tasks:withdue")) || [];
    if (!nums.length) {
      return res.status(200).json({ ok: true, checked: 0, overdue: 0, dueToday: 0, notified: 0 });
    }

    const keys = nums.map((n) => "task:" + n);
    const rows = (await redis.mget(...keys)).filter(Boolean);
    const todayStr = tashkentDateStr();

    const open = rows.filter((t) => t.dueDate && t.status !== "done");
    const overdue = open.filter((t) => t.dueDate < todayStr);
    const dueToday = open.filter((t) => t.dueDate === todayStr);

    let notified = 0;

    /* Дайджест в группу */
    try {
      const group = await redis.get("group");
      if (group && (overdue.length || dueToday.length)) {
        const line = (t) => `№${t.num} · ${t.company} · до ${t.dueDate}${t.assignee ? ` · ${t.assignee}` : ""}`;
        let text = `⏰ Напоминания на ${todayStr}\n`;
        if (overdue.length) {
          text += `\n🔴 Просрочено (${overdue.length}):\n` + overdue.map(line).join("\n");
        }
        if (dueToday.length) {
          text += `\n\n🟡 Срок сегодня (${dueToday.length}):\n` + dueToday.map(line).join("\n");
        }
        await tg("sendMessage", { chat_id: Number(group), text });
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
        await tg("sendMessage", { chat_id: t.client, text: MSG[lang](t.num, t.text, t.dueDate) });
        t.lastReminderDate = todayStr;
        await redis.set("task:" + t.num, t);
        notified++;
      } catch (e) { /* noop */ }
    }

    await logEvent("cron", "reminders_sent", {
      checked: open.length, overdue: overdue.length, dueToday: dueToday.length, notified,
    });

    return res.status(200).json({
      ok: true, checked: open.length, overdue: overdue.length, dueToday: dueToday.length, notified,
    });
  } catch (e) {
    console.error("cron reminders:", e);
    return res.status(200).json({ ok: false, error: String(e).slice(0, 300) });
  }
};
