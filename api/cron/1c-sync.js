/* ============================================================
   Finpulse CRM — ночной автопересинк справочников 1С (организации,
   контрагенты, договоры, номенклатура) по всем готовым базам.
   Вызывается Vercel Cron (см. vercel.json, "/api/cron/1c-sync").

   Зачем: раньше синк запускался только вручную кнопкой в интерфейсе —
   между нажатиями данные в Redis-картах (1c:orgmap/cpmap/ctmap/nommap)
   могли отставать от 1С (новые контрагенты, новые организации и т.д.).
   Этот крон каждую ночь проходит по всем базам со статусом "готов" и
   вызывает те же самые POST-действия /api/1c, что и кнопки в UI —
   никакой отдельной логики синка, только оркестрация вызовов.

   Авторизация: у /api/1c/* тот же JWT-гейт, что у /api/crm — обычному
   крону взять пользовательский JWT неоткуда, поэтому здесь он
   подписывается сам (тем же JWT_SECRET, что и весь проект) с ролью
   admin и очень коротким сроком жизни (2 минуты, только на время
   самого прогона).

   Защита эндпоинта: как и у /api/cron/reminders — если задан
   CRON_SECRET, требуется "Authorization: Bearer <CRON_SECRET>".
   ============================================================ */

const jwt = require("jsonwebtoken");
const redis = require("../../lib/redisClient.js");
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
async function tgToGroup(payload) {
  if (!TG_TOKEN) return null;
  let group = await redis.get("group");
  if (!group) return null;
  const call = (chatId) =>
    fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...payload }),
    }).then((r) => r.json()).catch(() => null);
  let resp = await call(Number(group));
  if (resp && !resp.ok && resp.parameters && resp.parameters.migrate_to_chat_id) {
    group = resp.parameters.migrate_to_chat_id;
    await redis.set("group", group);
    resp = await call(Number(group));
  }
  return resp;
}

const CRON_SECRET = process.env.CRON_SECRET || "";
const JWT_SECRET = process.env.JWT_SECRET || process.env.CRM_JWT_SECRET || "";
const SELF = process.env.CRM_API_ORIGIN || "https://finpulse-crm.vercel.app";

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  if (bufA.length !== bufB.length) return false;
  const crypto = require("crypto");
  return crypto.timingSafeEqual(bufA, bufB);
}

function internalToken() {
  if (!JWT_SECRET) return null;
  return jwt.sign({ role: "admin", name: "Cron 1C-sync" }, JWT_SECRET, { algorithm: "HS256", expiresIn: "2m" });
}

async function callApi1c(token, body) {
  const r = await fetch(`${SELF}/api/1c`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  return r.json().catch(() => ({ ok: false, error: "bad json" }));
}

module.exports = async (req, res) => {
  if (CRON_SECRET) {
    const auth = req.headers.authorization || "";
    if (!timingSafeStringEqual(auth, `Bearer ${CRON_SECRET}`)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
  }

  try {
    const token = internalToken();
    const pingRes = await fetch(`${SELF}/api/1c?r=ping`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(30000),
    }).then((r) => r.json()).catch(() => null);

    const apps = (pingRes && pingRes.apps) || [];
    const ready = apps.filter((a) => a.ready);
    const results = [];

    /* ?mode=light — облегчённый прогон для почасового триггера (GitHub
       Actions, см. .github/workflows/hourly-1c-sync.yml — Vercel Hobby
       cron не умеет чаще раза в сутки). Синкает только организации и
       контрагентов — самое "летучее" и нужное для актуальности CRM в
       течение дня. Полный прогон (номенклатура/договоры/кадры) остаётся
       только ночным: у баз Clobus жёсткий лимит одновременных сеансов
       (сами в этом убедились на PRESTIGE CLUB), гонять все 8 типов по
       всем базам каждый час — верный способ упереться в этот лимit. */
    const light = req.query && req.query.mode === "light";

    for (const a of ready) {
      const row = { code: a.code, name: a.name };
      row.orgs = await callApi1c(token, { action: "sync_orgs", app: a.code });
      row.counterparties = await callApi1c(token, { action: "sync_counterparties", app: a.code });
      if (!light) {
        row.contracts = await callApi1c(token, { action: "sync_contracts", app: a.code });
        row.nomenclature = await callApi1c(token, { action: "sync_nomenclature", app: a.code });
        row.reports = await callApi1c(token, { action: "sync_reports", app: a.code });
        row.employees = await callApi1c(token, { action: "sync_employees", app: a.code });
        row.positions = await callApi1c(token, { action: "sync_positions", app: a.code });
        row.departments = await callApi1c(token, { action: "sync_departments", app: a.code });
      }
      results.push(row);
    }

    /* Мониторинг: раньше сбой синка был виден только если кто-то открывал
       Vercel-логи или замечал устаревшие данные в 1С-разделе. Теперь если
       хотя бы одна база не смогла синкнуть ни один тип сущностей — шлём
       алерт в группу бухгалтеров с перечнем проблемных баз. */
    const KEYS = light
      ? ["orgs", "counterparties"]
      : ["orgs", "counterparties", "contracts", "nomenclature", "reports", "employees", "positions", "departments"];
    const brokenBases = results
      .filter((row) => KEYS.every((k) => row[k] && row[k].ok === false))
      .map((row) => `${row.name}: ${row.orgs && row.orgs.error ? row.orgs.error : "неизвестная ошибка"}`);
    if (brokenBases.length) {
      const label = light ? "Часовой синк 1С" : "Ночной синк 1С";
      await tgToGroup({
        text: `⚠️ <b>${label} не смог обновить ни один справочник</b> в ${brokenBases.length} из ${ready.length} баз:\n${brokenBases.map((b) => "• " + b).join("\n")}\n\nПроверьте логи Vercel (cron/1c-sync) и доступ к базе в Clobus.`,
        parse_mode: "HTML",
      }).catch(() => null);
    }

    return res.status(200).json({ ok: true, mode: light ? "light" : "full", total: apps.length, synced: ready.length, results });
  } catch (e) {
    console.error("1c-sync cron:", e);
    await tgToGroup({
      text: `🔴 <b>Ночной синк 1С упал целиком</b>\n${String(e).slice(0, 300)}\n\nПроверьте логи Vercel (cron/1c-sync).`,
      parse_mode: "HTML",
    }).catch(() => null);
    return res.status(200).json({ ok: false, error: String(e).slice(0, 300) });
  }
};
