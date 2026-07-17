/* ============================================================
   Finpulse CRM — служебные операции инфраструктуры (не бизнес-данные).

   GET  /api/ops?r=health  — проверяет бот (Telegram getMe), CRM
                             (себя же, без круговой зависимости — просто
                             читает Redis) и OData 1С (через pingAll,
                             как /api/1c?r=ping). Шлёт алерт в группу,
                             только если статус ИЗМЕНИЛСЯ с прошлой
                             проверки (Redis-флаг ops:health:lastBad),
                             чтобы не спамить каждые 5 минут одним и тем
                             же "всё ещё лежит".

   Вызывается GitHub Actions workflow раз в 5 минут (Vercel Hobby cron
   не может чаще раза в сутки) — см. .github/workflows/health-check.yml.
   Авторизация — тот же CRON_SECRET, что у /api/cron/*.
   ============================================================ */

const redis = require("../lib/redisClient.js");

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET || "";
const ODATA_BASE = process.env.ODATA_1C_BASE || "https://clobus.uz";
const ODATA_LOGIN = process.env.ODATA_1C_LOGIN || "";
const ODATA_PASSWORD = process.env.ODATA_1C_PASSWORD || "";

function timingSafeStringEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function tgToGroup(payload) {
  if (!TG_TOKEN) return null;
  const group = await redis.get("group");
  if (!group) return null;
  const call = (chatId) =>
    fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, parse_mode: "HTML", ...payload }),
    }).then((r) => r.json()).catch(() => null);
  let resp = await call(Number(group));
  if (resp && !resp.ok && resp.parameters && resp.parameters.migrate_to_chat_id) {
    const newId = resp.parameters.migrate_to_chat_id;
    await redis.set("group", newId);
    resp = await call(Number(newId));
  }
  return resp;
}

async function checkBot() {
  if (!TG_TOKEN) return { ok: false, error: "TELEGRAM_BOT_TOKEN не задан" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getMe`, {
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    return { ok: !!(j && j.ok), detail: j && j.ok ? j.result.username : j };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 150) };
  }
}

async function checkRedis() {
  try {
    await redis.set("ops:health:ping", Date.now(), { ex: 60 });
    const v = await redis.get("ops:health:ping");
    return { ok: v != null };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 150) };
  }
}

async function checkOData() {
  if (!ODATA_LOGIN || !ODATA_PASSWORD) return { ok: false, error: "ODATA_1C_LOGIN/PASSWORD не заданы" };
  try {
    // одна "эталонная" база (finpulse, всегда должна быть готова) — полный
    // pingAll по всем 10 базам был бы слишком тяжёлым для проверки раз в 5 минут
    const auth = "Basic " + Buffer.from(`${ODATA_LOGIN}:${ODATA_PASSWORD}`).toString("base64");
    const r = await fetch(`${ODATA_BASE}/a/acc311/46516/odata/standard.odata/?$format=json`, {
      headers: { Authorization: auth, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    return { ok: r.status === 200, status: r.status };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 150) };
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const q = req.query || {};

  if (CRON_SECRET) {
    const auth = req.headers.authorization || "";
    if (!timingSafeStringEqual(auth, `Bearer ${CRON_SECRET}`)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
  }

  if (q.r !== "health") {
    return res.status(404).json({ ok: false, error: "unknown route" });
  }

  const [bot, redisCheck, odata] = await Promise.all([checkBot(), checkRedis(), checkOData()]);
  const allOk = bot.ok && redisCheck.ok && odata.ok;

  let alerted = false;
  try {
    const wasBad = await redis.get("ops:health:lastBad");
    if (!allOk && !wasBad) {
      const lines = [
        !bot.ok ? `• Бот: ${bot.error || "недоступен"}` : null,
        !redisCheck.ok ? `• Redis: ${redisCheck.error || "недоступен"}` : null,
        !odata.ok ? `• 1С OData: HTTP ${odata.status || "?"} ${odata.error || ""}` : null,
      ].filter(Boolean).join("\n");
      await tgToGroup({ text: `🔴 <b>Что-то упало</b>\n\n${lines}` });
      await redis.set("ops:health:lastBad", "1", { ex: 3600 });
      alerted = true;
    } else if (allOk && wasBad) {
      await tgToGroup({ text: "✅ <b>Всё снова работает</b>\n\nБот, CRM и 1С OData отвечают." });
      await redis.del("ops:health:lastBad");
      alerted = true;
    }
  } catch (e) { /* алерт не критичен для самого health-check */ }

  return res.status(200).json({ ok: allOk, bot, redis: redisCheck, odata, alerted });
};
