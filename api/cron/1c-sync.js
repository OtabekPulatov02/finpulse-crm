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

    for (const a of ready) {
      const row = { code: a.code, name: a.name };
      row.orgs = await callApi1c(token, { action: "sync_orgs", app: a.code });
      row.counterparties = await callApi1c(token, { action: "sync_counterparties", app: a.code });
      row.contracts = await callApi1c(token, { action: "sync_contracts", app: a.code });
      row.nomenclature = await callApi1c(token, { action: "sync_nomenclature", app: a.code });
      row.reports = await callApi1c(token, { action: "sync_reports", app: a.code });
      row.employees = await callApi1c(token, { action: "sync_employees", app: a.code });
      results.push(row);
    }

    return res.status(200).json({ ok: true, total: apps.length, synced: ready.length, results });
  } catch (e) {
    console.error("1c-sync cron:", e);
    return res.status(200).json({ ok: false, error: String(e).slice(0, 300) });
  }
};
