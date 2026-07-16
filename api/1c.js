/* ============================================================
   Finpulse CRM — интеграция с 1С:Фреш (Clobus.uz)

   Конфигурация: «Бухгалтерия для Узбекистана, ред. 3.0».
   Доступ: стандартный OData-интерфейс каждого приложения
   (basic auth пользователем 1С, например crm_api).

   Статус: OData включён на платформе, но состав объектов
   настраивает провайдер (Venkon/Clobus) по обращению.
   Модуль работает в «деградированном» режиме, пока состав пуст:
   ping показывает готовность каждой базы.

   GET  /api/1c?r=apps                     → список приложений
   GET  /api/1c?r=ping                     → доступность OData по всем базам
   GET  /api/1c?r=orgs&app=<code>          → организации приложения
   GET  /api/1c?r=meta&app=<code>          → список сущностей OData (что включили)
   POST /api/1c {action:"sync_orgs", app}  → организации → клиенты CRM
   ============================================================ */

const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const BASE = process.env.ODATA_1C_BASE || "https://clobus.uz";
const LOGIN = process.env.ODATA_1C_LOGIN || "";
const PASSWORD = process.env.ODATA_1C_PASSWORD || "";

/* Приложения абонента 6366 (инвентаризация 13.07.2026).
   Можно переопределить ключом Redis 1c:apps (JSON-массив). */
const DEFAULT_APPS = [
  { code: "68111", path: "/a/acc316/68111", name: "ADELE GROUP COMP" },
  { code: "46516", path: "/a/acc311/46516", name: "finpulse" },
  { code: "70639", path: "/a/acc318/70639", name: "Online Organic" },
  { code: "55833", path: "/a/acc311/55833", name: "OOO SERPHUNT" },
  { code: "72467", path: "/a/acc319/72467", name: "OOO UGOLOK" },
  { code: "69781", path: "/a/acc317/69781", name: "PRESTIGE CLUB" },
  { code: "52354", path: "/a/acc312/52354", name: "PROMET" },
  { code: "63564", path: "/a/acc315/63564", name: "RED TEAM TASHKENT" },
  { code: "54437", path: "/a/acc314/54437", name: "THE TEAM PROJECT" },
  { code: "70307", path: "/a/acc318/70307", name: "Бухгалтерия УЗ 3.0 (без имени)" },
];

async function getApps() {
  try {
    const custom = await redis.get("1c:apps");
    if (Array.isArray(custom) && custom.length) return custom;
  } catch (e) { /* noop */ }
  return DEFAULT_APPS;
}

function authHeader() {
  return "Basic " + Buffer.from(`${LOGIN}:${PASSWORD}`).toString("base64");
}

async function odata(appPath, resource, params) {
  const url = `${BASE}${appPath}/odata/standard.odata/${resource}${params ? `?${params}` : ""}`;
  const r = await fetch(url, {
    headers: { Authorization: authHeader(), Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* xml или html */ }
  return { status: r.status, json, text };
}

async function logEvent(event, data) {
  try {
    await redis.lpush("logs:crm", JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
    await redis.ltrim("logs:crm", 0, 499);
  } catch (e) { /* noop */ }
}

/* ---- ping всех баз: доступен ли OData и настроен ли состав ---- */
async function pingAll() {
  const apps = await getApps();
  const results = await Promise.all(apps.map(async (a) => {
    try {
      const r = await odata(a.path, "", "$format=json");
      const entities = r.json && Array.isArray(r.json.value) ? r.json.value.length : null;
      return {
        ...a,
        reachable: r.status === 200,
        status: r.status,
        entities,
        ready: r.status === 200 && (entities ?? 0) > 0,
      };
    } catch (e) {
      return { ...a, reachable: false, entities: null, ready: false, error: String(e).slice(0, 120) };
    }
  }));
  return results;
}

/* ---- организации приложения (после включения состава OData) ---- */
async function getOrgs(appPath) {
  const r = await odata(appPath, "Catalog_Организации",
    "$format=json&$select=Ref_Key,Description,НаименованиеПолное,ИНН,КодНалоговогоОргана,ОсновнойБанковскийСчет_Key,ДатаРегистрации&$filter=DeletionMark eq false");
  if (r.status === 401) return { ok: false, error: "auth: проверьте ODATA_1C_LOGIN/PASSWORD (пользователь 1С в этой базе)" };
  if (r.status === 404) return { ok: false, error: "Catalog_Организации не включён в состав OData — настройте состав REST-сервиса" };
  if (r.status !== 200 || !r.json) return { ok: false, error: `HTTP ${r.status}` };

  /* банковские счета и банки — чтобы заполнить р/с, МФО и название банка */
  let accounts = {}, banks = {};
  try {
    const ra = await odata(appPath, "Catalog_БанковскиеСчета", "$format=json&$select=Ref_Key,НомерСчета,Банк_Key");
    for (const a of ra.json?.value || []) accounts[a.Ref_Key] = a;
    const rb = await odata(appPath, "Catalog_Банки", "$format=json&$select=Ref_Key,Code,Description");
    for (const b of rb.json?.value || []) banks[b.Ref_Key] = b;
  } catch (e) { /* реквизиты банка не критичны */ }

  return {
    ok: true,
    orgs: (r.json.value || []).map((o) => {
      const acc = accounts[o["ОсновнойБанковскийСчет_Key"]] || null;
      const bank = acc ? banks[acc["Банк_Key"]] || null : null;
      return {
        ref: o.Ref_Key,
        name: o.Description,
        fullName: o["НаименованиеПолное"] || null,
        inn: o["ИНН"] || null,
        taxOffice: o["КодНалоговогоОргана"] || null,
        bankAccount: acc ? acc["НомерСчета"] || null : null,
        mfo: bank ? bank.Code || null : null,
        bank: bank ? bank.Description || null : null,
      };
    }),
  };
}

/* ---- организации 1С → карточки клиентов CRM ---- */
function normCompany(str) {
  return String(str || "").toLowerCase()
    .replace(/["«»'`]/g, "")
    .replace(/\b(ооо|оао|зао|ип|ао|мчж|mchj|ooo|llc|ltd|mas'?uliyati cheklangan jamiyati|nodavlat ta'?lim muassasasi)\b/g, "")
    .replace(/[^a-zа-яё0-9]+/gi, " ").trim().replace(/\s+/g, " ");
}

async function syncOrgs(appPath, appName, actor) {
  const res = await getOrgs(appPath);
  if (!res.ok) return res;
  let created = 0, updated = 0;
  for (const org of res.orgs) {
    const norm = normCompany(org.name);
    if (!norm) continue;
    const existingId = await redis.get("clientcompany:" + norm);
    const fields1c = {
      inn: org.inn || null,
      fullName: org.fullName || null,
      taxOffice: org.taxOffice || null,
      bankAccount: org.bankAccount || null,
      mfo: org.mfo || null,
      bank: org.bank || null,
    };
    if (existingId) {
      const c = (await redis.get("client:" + existingId)) || {};
      const next = { ...c, updatedAt: new Date().toISOString(), source1c: { app: appPath, ref: org.ref, name: org.name } };
      for (const [k, v] of Object.entries(fields1c)) if (v != null) next[k] = v;
      await redis.set("client:" + existingId, next);
      updated++;
      await redis.set("1c:orgmap:" + norm, { app: appPath, ref: org.ref, name: org.name });
    } else {
      const id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await redis.set("client:" + id, {
        id, company: org.name, phone: null, telegramId: null,
        status: "active", tariff: null, assignedTo: null,
        ...fields1c,
        source1c: { app: appPath, ref: org.ref, name: org.name },
        createdAt: new Date().toISOString(),
      });
      await redis.set("clientcompany:" + norm, id);
      await redis.sadd("clients", id);
      await redis.set("1c:orgmap:" + norm, { app: appPath, ref: org.ref, name: org.name });
      created++;
    }
  }
  await logEvent("1c_sync_orgs", { app: appName, created, updated, total: res.orgs.length, by: actor || "CRM" });
  return { ok: true, created, updated, total: res.orgs.length };
}


/* ---------------- Исполнитель: создание документов 1С из задач CRM ----------------
   ГЛАВНАЯ ФИЧА: AI разобрал задачу клиента → черновик → документ в базе 1С
   этого клиента (НЕПРОВЕДЁННЫЙ, Posted=false) → бухгалтер проверяет и
   проводит. Точные имена реквизитов сверяются с $metadata после включения
   состава OData провайдером. */

const DOC_1C_TYPES = {
  payment_out: "Document_ПлатежноеПоручениеИсходящее",
  payment_in: "Document_ПлатежноеПоручениеВходящее",
  invoice_esf: "Document_СчетФактураВыданный",
  schet: "Document_СчетНаОплатуПокупателю",
  postuplenie: "Document_ПоступлениеТоваровУслуг",
  realizatsiya: "Document_РеализацияТоваровУслуг",
  act_sverki: "Document_АктСверкиВзаиморасчетов",
  doverennost: "Document_Доверенность",
};

async function orgFor(company) {
  const norm = normCompany(company || "");
  if (!norm) return null;
  return await redis.get("1c:orgmap:" + norm);
}

/* Универсальное создание документа (черновик, Posted=false) */
async function createDraftDoc(appPath, entity, fields) {
  const url = `${BASE}${appPath}/odata/standard.odata/${entity}?$format=json`;
  const payload = { ...fields, Posted: false };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: authHeader(), Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* noop */ }
  if (r.status === 404) return { ok: false, error: `${entity} не включён в состав OData — ждём поддержку Clobus` };
  if (r.status === 401) return { ok: false, error: "auth: проверьте ODATA_1C_LOGIN/PASSWORD" };
  if (r.status >= 400) return { ok: false, error: `HTTP ${r.status}: ${text.slice(0, 300)}` };
  return { ok: true, ref: json?.Ref_Key || null, number: json?.Number || null, raw: json };
}

/* Выполнение задачи CRM: черновик AI → документ в 1С базе клиента */
async function executeTaskIn1C(num, actor) {
  const task = await redis.get("task:" + num);
  if (!task) return { ok: false, error: "task not found" };
  const draft = task.aiDraft;
  if (!draft || !draft.type) return { ok: false, error: "у задачи нет AI-черновика — сначала POST /api/ai {action:'draft', num}" };
  const entity = DOC_1C_TYPES[draft.type];
  if (!entity) return { ok: false, error: `тип «${draft.type}» пока не маппится на документ 1С` };
  const org = await orgFor(task.company);
  if (!org) return { ok: false, error: `организация «${task.company}» не найдена в картах 1С — выполните синк организаций` };

  /* Базовые поля, общие для документов БУ УЗ 3.0. Точная схема реквизитов
     (контрагент, счета, суммы по табличным частям) дозаполняется после
     $metadata; всё содержимое черновика кладём в Комментарий, чтобы
     бухгалтер открыл документ с полным контекстом. */
  const comment =
    `[Finpulse CRM · задача №${num}] ${draft.title || ""}\n` +
    (draft.counterparty ? `Контрагент: ${draft.counterparty}${draft.counterpartyInn ? " (ИНН " + draft.counterpartyInn + ")" : ""}\n` : "") +
    (draft.amount ? `Сумма: ${draft.amount} UZS${draft.vat ? " · НДС " + draft.vat : ""}\n` : "") +
    (draft.purpose ? `Назначение: ${draft.purpose}\n` : "") +
    `Подготовлено AI-бухгалтером, проверьте и проведите.`;

  const fields = {
    Date: new Date().toISOString().slice(0, 19),
    "Организация_Key": org.ref,
    "Комментарий": comment.slice(0, 1000),
  };
  const r = await createDraftDoc(org.app, entity, fields);
  if (!r.ok) return r;

  task.doc1c = { app: org.app, entity, ref: r.ref, number: r.number, at: new Date().toISOString(), by: actor || "AI" };
  await redis.set("task:" + num, task);
  await logEvent("1c_draft_created", { num, entity, app: org.app, ref: r.ref, by: actor || "AI" });
  return { ok: true, entity, ref: r.ref, number: r.number, app: org.app };
}

/* ---------------- handler ---------------- */
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-api-key,authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  /* та же JWT-проверка, что в crm.js */
  let authUser = null;
  const JWT_SECRET = process.env.JWT_SECRET || process.env.CRM_JWT_SECRET || "";
  if (JWT_SECRET) {
    try {
      const jwt = require("jsonwebtoken");
      const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
      if (m) authUser = jwt.verify(m[1], JWT_SECRET, { algorithms: ["HS256"] });
    } catch (e) { /* noop */ }
    const isStaff = authUser && (authUser.role === "admin" || authUser.role === "accountant");
    if (!isStaff) return res.status(401).json({ ok: false, error: "staff auth required" });
  }

  if (!LOGIN || !PASSWORD) {
    return res.status(200).json({
      ok: false,
      error: "Задайте ODATA_1C_LOGIN и ODATA_1C_PASSWORD в переменных Vercel (пользователь 1С, например crm_api)",
    });
  }

  try {
    const q = req.query || {};
    const apps = await getApps();
    const findApp = (code) => apps.find((a) => a.code === String(code));

    if (req.method === "GET") {
      if (q.r === "apps") return res.status(200).json({ ok: true, apps });
      if (q.r === "ping") return res.status(200).json({ ok: true, apps: await pingAll() });
      if (q.r === "meta" && q.app) {
        const a = findApp(q.app);
        if (!a) return res.status(200).json({ ok: false, error: "unknown app" });
        const r = await odata(a.path, "", "$format=json");
        return res.status(200).json({ ok: r.status === 200, status: r.status, entities: r.json?.value ?? [] });
      }
      if (q.r === "orgs" && q.app) {
        const a = findApp(q.app);
        if (!a) return res.status(200).json({ ok: false, error: "unknown app" });
        return res.status(200).json(await getOrgs(a.path));
      }
      return res.status(200).json({ ok: true, service: "Finpulse 1C bridge", routes: ["apps", "ping", "meta", "orgs"] });
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
      if (body && body.action === "execute_task" && body.num) {
        return res.status(200).json(await executeTaskIn1C(Number(body.num), authUser?.name));
      }
      if (body && body.action === "create_draft" && body.app && body.entity) {
        const a = findApp(body.app);
        if (!a) return res.status(200).json({ ok: false, error: "unknown app" });
        return res.status(200).json(await createDraftDoc(a.path, String(body.entity), body.fields || {}));
      }
      if (body && body.action === "sync_orgs" && body.app) {
        const a = findApp(body.app);
        if (!a) return res.status(200).json({ ok: false, error: "unknown app" });
        return res.status(200).json(await syncOrgs(a.path, a.name, authUser?.name));
      }
      return res.status(200).json({ ok: false, error: "unknown action" });
    }

    res.status(405).json({ ok: false });
  } catch (e) {
    console.error("1c api:", e);
    res.status(200).json({ ok: false, error: String(e).slice(0, 300) });
  }
};
