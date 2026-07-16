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
    "$format=json&$select=Ref_Key,Description,НаименованиеПолное,ИНН,КодНалоговогоОргана,ОсновнойБанковскийСчет_Key,ДатаРегистрации,ПИНФЛ,РегистрационныйКодПлательщикаНДС&$filter=DeletionMark eq false");
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
        pinfl: o["ПИНФЛ"] || null,
        vatCode: o["РегистрационныйКодПлательщикаНДС"] || null,
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
      pinfl: org.pinfl || null,
      vatCode: org.vatCode || null,
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

/* ВНИМАНИЕ: имена сверены с реальным $metadata базы (16.07.2026).
   payment_out/payment_in и act_sverki раньше указывали на НЕСУЩЕСТВУЮЩИЕ
   сущности (Document_ПлатежноеПоручениеИсходящее/Входящее, Document_АктСверкиВзаиморасчетов) —
   в этой конфигурации нет отдельных документов на приход/расход платежа и нет акта
   сверки как отдельного документа. Реальные аналоги:
   - платёж (оба направления) — единый Document_ПлатежноеПоручение с полем ВидОперации;
   - акт сверки — ближайший аналог Document_ДокументРасчетовСКонтрагентом (документ расчётов
     с контрагентом: Организация/Контрагент/Договор/Сумма/Комментарий — то, что нужно для черновика). */
const DOC_1C_TYPES = {
  payment_out: "Document_ПлатежноеПоручение",
  payment_in: "Document_ПлатежноеПоручение",
  invoice_esf: "Document_СчетФактураВыданный",
  schet: "Document_СчетНаОплатуПокупателю",
  postuplenie: "Document_ПоступлениеТоваровУслуг",
  realizatsiya: "Document_РеализацияТоваровУслуг",
  act_sverki: "Document_ДокументРасчетовСКонтрагентом",
  doverennost: "Document_Доверенность",
  /* HR (проверено по $metadata реальной базы 13.07.2026) */
  hr_hire: "Document_ПриемНаРаботу",
  hr_fire: "Document_Увольнение",
  hr_leave: "Document_Отпуск",
};

/* типы документов, где реквизит контрагента — простая ссылка Контрагент_Key
   (не полиморфное поле, как в Document_ПлатежноеПоручение) — для них можно
   безопасно подставить Ref_Key контрагента из синка. */
const COUNTERPARTY_KEY_ENTITIES = new Set([
  "Document_СчетФактураВыданный",
  "Document_СчетНаОплатуПокупателю",
  "Document_ПоступлениеТоваровУслуг",
  "Document_РеализацияТоваровУслуг",
  "Document_ДокументРасчетовСКонтрагентом",
  "Document_Доверенность",
]);

async function orgFor(company) {
  const norm = normCompany(company || "");
  if (!norm) return null;
  return await redis.get("1c:orgmap:" + norm);
}

/* ---- контрагенты приложения (для подстановки Контрагент_Key в черновики) ---- */
async function getCounterparties(appPath) {
  const r = await odata(appPath, "Catalog_Контрагенты",
    "$format=json&$select=Ref_Key,Description,НаименованиеПолное,ИНН,ПИНФЛ&$filter=DeletionMark eq false");
  if (r.status === 401) return { ok: false, error: "auth: проверьте ODATA_1C_LOGIN/PASSWORD" };
  if (r.status === 404) return { ok: false, error: "Catalog_Контрагенты не включён в состав OData — настройте состав REST-сервиса" };
  if (r.status !== 200 || !r.json) return { ok: false, error: `HTTP ${r.status}` };
  return {
    ok: true,
    counterparties: (r.json.value || []).map((c) => ({
      ref: c.Ref_Key, name: c.Description, fullName: c["НаименованиеПолное"] || null,
      inn: c["ИНН"] || null, pinfl: c["ПИНФЛ"] || null,
    })),
  };
}

async function syncCounterparties(appPath, appName, actor) {
  const res = await getCounterparties(appPath);
  if (!res.ok) return res;
  let count = 0;
  const light = [];
  for (const cp of res.counterparties) {
    const norm = normCompany(cp.name);
    if (!norm) continue;
    await redis.set("1c:cpmap:" + appPath + ":" + norm, { ref: cp.ref, name: cp.name, inn: cp.inn });
    light.push({ ref: cp.ref, name: cp.name, norm });
    count++;
  }
  /* лёгкий кэш всего списка (без doc/comment полей) — нужен только для нечёткого поиска,
     чтобы не делать дорогой перебор ключей Redis на каждый черновик */
  await redis.set("1c:cplist:" + appPath, light);
  await logEvent("1c_sync_counterparties", { app: appName, count, by: actor || "CRM" });
  return { ok: true, total: res.counterparties.length, mapped: count };
}

async function counterpartyRefFor(appPath, name) {
  const norm = normCompany(name || "");
  if (!norm) return null;
  return await redis.get("1c:cpmap:" + appPath + ":" + norm);
}

/* Нечёткий поиск контрагента, когда точного совпадения по имени нет — например,
   при опечатке, другой раскладке (латиница вместо кириллицы) или сокращении.
   Простая эвристика без внешних библиотек: пересечение по подстроке + общим словам. */
function fuzzyScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const wa = new Set(a.split(" ").filter((w) => w.length > 2));
  const wb = new Set(b.split(" ").filter((w) => w.length > 2));
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.max(wa.size, wb.size);
}

async function suggestCounterparties(appPath, name, limit) {
  const norm = normCompany(name || "");
  if (!norm) return [];
  const list = (await redis.get("1c:cplist:" + appPath)) || [];
  const scored = list
    .map((c) => ({ ...c, score: fuzzyScore(norm, c.norm) }))
    .filter((c) => c.score >= 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit || 3);
  return scored.map((c) => ({ ref: c.ref, name: c.name }));
}

/* ---------- Номенклатура (товары/услуги) — для строк документов ---------- */
async function getNomenclature(appPath) {
  const r = await odata(appPath, "Catalog_Номенклатура",
    "$format=json&$select=Ref_Key,Description,ЕдиницаИзмерения_Key,СтавкаНДС,Услуга&$filter=DeletionMark eq false and IsFolder eq false");
  if (r.status === 401) return { ok: false, error: "auth: проверьте ODATA_1C_LOGIN/PASSWORD" };
  if (r.status === 404) return { ok: false, error: "Catalog_Номенклатура не включён в состав OData — настройте состав REST-сервиса" };
  if (r.status !== 200 || !r.json) return { ok: false, error: `HTTP ${r.status}` };
  return {
    ok: true,
    items: (r.json.value || []).map((n) => ({
      ref: n.Ref_Key, name: n.Description, unit: n["ЕдиницаИзмерения_Key"] || null,
      vat: n["СтавкаНДС"] || null, isService: !!n["Услуга"],
    })),
  };
}

async function syncNomenclature(appPath, appName, actor) {
  const res = await getNomenclature(appPath);
  if (!res.ok) return res;
  let count = 0;
  for (const it of res.items) {
    const norm = normCompany(it.name);
    if (!norm) continue;
    await redis.set("1c:nommap:" + appPath + ":" + norm, { ref: it.ref, name: it.name, unit: it.unit, vat: it.vat });
    count++;
  }
  await logEvent("1c_sync_nomenclature", { app: appName, count, by: actor || "CRM" });
  return { ok: true, total: res.items.length, mapped: count };
}

async function nomenclatureRefFor(appPath, name) {
  const norm = normCompany(name || "");
  if (!norm) return null;
  return await redis.get("1c:nommap:" + appPath + ":" + norm);
}

/* ---------- Договоры контрагентов — для ДоговорКонтрагента_Key ---------- */
async function getContracts(appPath) {
  const r = await odata(appPath, "Catalog_ДоговорыКонтрагентов",
    "$format=json&$select=Ref_Key,Description,Owner_Key,Организация_Key,Номер&$filter=DeletionMark eq false");
  if (r.status === 401) return { ok: false, error: "auth: проверьте ODATA_1C_LOGIN/PASSWORD" };
  if (r.status === 404) return { ok: false, error: "Catalog_ДоговорыКонтрагентов не включён в состав OData — настройте состав REST-сервиса" };
  if (r.status !== 200 || !r.json) return { ok: false, error: `HTTP ${r.status}` };
  return {
    ok: true,
    contracts: (r.json.value || []).map((c) => ({
      ref: c.Ref_Key, name: c.Description, owner: c["Owner_Key"] || null, number: c["Номер"] || null,
    })),
  };
}

async function syncContracts(appPath, appName, actor) {
  const res = await getContracts(appPath);
  if (!res.ok) return res;
  const perOwner = new Map();
  for (const ct of res.contracts) {
    if (!ct.owner) continue;
    const norm = normCompany(ct.name);
    if (norm) await redis.set("1c:ctmap:" + appPath + ":" + ct.owner + ":" + norm, { ref: ct.ref, name: ct.name });
    if (!perOwner.has(ct.owner)) perOwner.set(ct.owner, []);
    perOwner.get(ct.owner).push(ct.ref);
  }
  let count = 0;
  for (const [owner, refs] of perOwner.entries()) {
    /* если у контрагента ровно один договор — используем его по умолчанию,
       когда AI-черновик не называет договор явно */
    if (refs.length === 1) {
      await redis.set("1c:ctdefault:" + appPath + ":" + owner, refs[0]);
      count++;
    }
  }
  await logEvent("1c_sync_contracts", { app: appName, count: res.contracts.length, defaults: count, by: actor || "CRM" });
  return { ok: true, total: res.contracts.length, owners: perOwner.size, defaults: count };
}

async function contractRefFor(appPath, ownerRef, name) {
  if (!ownerRef) return null;
  const norm = normCompany(name || "");
  if (norm) {
    const exact = await redis.get("1c:ctmap:" + appPath + ":" + ownerRef + ":" + norm);
    if (exact) return exact.ref;
  }
  return await redis.get("1c:ctdefault:" + appPath + ":" + ownerRef);
}

/* тип черновика → название табличной части документа, куда кладём строки товаров/услуг */
const TABULAR_PART_BY_TYPE = {
  realizatsiya: "Товары",
  schet: "Товары",
  postuplenie: "Товары",
};

/* сопоставление НДС-текста из черновика с реальным enum-значением 1С (строка вида "НДС12"/"БезНДС") */
function vatEnumFromText(vat) {
  const s = String(vat || "").toLowerCase();
  if (s.includes("12")) return "НДС12";
  if (s.includes("без") || s.includes("0") || s === "null") return "БезНДС";
  return "НДС12";
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
/* Проверка дублей: не создаём ещё один документ, если за последние 24ч по этой же
   компании/типу/сумме уже был создан документ в 1С (в т.ч. из другой задачи) —
   защищает от повторных ЭСФ/платежей при неаккуратных или повторных поручениях. */
async function findRecentSimilarDoc1C(company, type, amount, excludeNum) {
  const n = Number((await redis.get("counter:task")) || 0);
  if (!n) return null;
  const max = 100 + n;
  const from = Math.max(101, max - 49); // последние ~50 задач достаточно для окна в 24ч
  const keys = [];
  for (let i = max; i >= from; i--) keys.push("task:" + i);
  const rows = keys.length ? await redis.mget(...keys) : [];
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  for (const t of rows) {
    if (!t || t.num === excludeNum || !t.doc1c || !t.aiDraft) continue;
    if (t.company !== company) continue;
    if (t.aiDraft.type !== type) continue;
    const createdAt = new Date(t.doc1c.at || 0).getTime();
    if (!createdAt || now - createdAt > DAY) continue;
    const a1 = Number(t.aiDraft.amount) || 0;
    const a2 = Number(amount) || 0;
    if (a1 && a2 && Math.abs(a1 - a2) / Math.max(a1, a2) > 0.01) continue; // суммы различаются более чем на 1%
    return { num: t.num, ref: t.doc1c.ref, number: t.doc1c.number, at: t.doc1c.at };
  }
  return null;
}

async function executeTaskIn1C(num, actor, force) {
  const task = await redis.get("task:" + num);
  if (!task) return { ok: false, error: "task not found" };
  const draft = task.aiDraft;
  if (!draft || !draft.type) return { ok: false, error: "у задачи нет AI-черновика — сначала POST /api/ai {action:'draft', num}" };
  const entity = DOC_1C_TYPES[draft.type];
  if (!entity) return { ok: false, error: `тип «${draft.type}» пока не маппится на документ 1С` };
  const org = await orgFor(task.company);
  if (!org) return { ok: false, error: `организация «${task.company}» не найдена в картах 1С — выполните синк организаций` };

  if (!force) {
    const dup = await findRecentSimilarDoc1C(task.company, draft.type, draft.amount, num);
    if (dup) {
      return {
        ok: false,
        duplicate: true,
        error: `Похоже, такой документ уже создан сегодня: задача №${dup.num}, документ №${dup.number || dup.ref}. Если это разные операции — вызовите execute_task ещё раз с force:true.`,
        existingTask: dup.num,
      };
    }
  }

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

  /* если для этого типа документа реквизит контрагента — простая ссылка,
     подставляем реальный Ref_Key из синка контрагентов (не только текст в комментарии) */
  if (COUNTERPARTY_KEY_ENTITIES.has(entity) && draft.counterparty) {
    try {
      const cp = await counterpartyRefFor(org.app, draft.counterparty);
      if (cp) {
        fields["Контрагент_Key"] = cp.ref;
        try {
          const ctRef = await contractRefFor(org.app, cp.ref, draft.counterpartyContract);
          if (ctRef) fields["ДоговорКонтрагента_Key"] = ctRef;
        } catch (e2) { /* договор не критичен */ }
      } else if (!force) {
        /* точного совпадения нет — если есть похожие варианты, лучше переспросить,
           чем молча создать документ без Контрагент_Key или привязать не того контрагента */
        try {
          const suggestions = await suggestCounterparties(org.app, draft.counterparty, 3);
          if (suggestions.length) {
            return {
              ok: false,
              counterpartyAmbiguous: true,
              suggestions,
              error: `Контрагент «${draft.counterparty}» не найден точно в синке 1С. Похожие варианты: ${suggestions.map((s) => s.name).join(", ")}. Уточните, какой контрагент имелся в виду, или вызовите execute_task с force:true, чтобы создать документ без привязки контрагента.`,
            };
          }
        } catch (e3) { /* noop — нет подсказок, создаём без Контрагент_Key как раньше */ }
      }
    } catch (e) { /* контрагент не критичен — документ всё равно создастся с текстом в комментарии */ }
  }

  /* строки товаров/услуг: если черновик содержит items и для этого типа документа
     есть табличная часть "Товары" — строим реальные строки со ссылкой на номенклатуру
     (если найдена по синку), иначе оставляем только текст в наименовании строки. */
  const tabularPart = TABULAR_PART_BY_TYPE[draft.type];
  if (tabularPart && Array.isArray(draft.items) && draft.items.length) {
    const rows = [];
    for (let i = 0; i < draft.items.length; i++) {
      const it = draft.items[i] || {};
      const qty = Number(it.qty) || 1;
      const price = Number(it.price) || 0;
      const amount = Number(it.amount) || qty * price;
      const vatRate = vatEnumFromText(it.vat || draft.vat);
      let nom = null;
      try { nom = it.name ? await nomenclatureRefFor(org.app, it.name) : null; } catch (e) { /* noop */ }
      const row = {
        LineNumber: String(i + 1),
        Количество: qty,
        Цена: price,
        Сумма: amount,
        СтавкаНДС: vatRate,
      };
      if (nom) {
        row["Номенклатура_Key"] = nom.ref;
        if (nom.unit) row["ЕдиницаИзмерения_Key"] = nom.unit;
      }
      rows.push(row);
    }
    fields[tabularPart] = rows;
  }

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
      if (q.r === "counterparties" && q.app) {
        const a = findApp(q.app);
        if (!a) return res.status(200).json({ ok: false, error: "unknown app" });
        const r = await getCounterparties(a.path);
        if (!r.ok) return res.status(200).json(r);
        return res.status(200).json({ ok: true, count: r.counterparties.length, sample: r.counterparties.slice(0, 3) });
      }
      if (q.r === "nomenclature" && q.app) {
        const a = findApp(q.app);
        if (!a) return res.status(200).json({ ok: false, error: "unknown app" });
        const r = await getNomenclature(a.path);
        if (!r.ok) return res.status(200).json(r);
        return res.status(200).json({ ok: true, count: r.items.length, sample: r.items.slice(0, 3) });
      }
      if (q.r === "contracts" && q.app) {
        const a = findApp(q.app);
        if (!a) return res.status(200).json({ ok: false, error: "unknown app" });
        const r = await getContracts(a.path);
        if (!r.ok) return res.status(200).json(r);
        return res.status(200).json({ ok: true, count: r.contracts.length, sample: r.contracts.slice(0, 3) });
      }
      if (q.r === "schema2" && q.app && q.entity) {
        /* временный роут: свойства произвольной сущности $metadata (Catalog_ или Document_),
           чтобы свериться перед добавлением синка контрагентов/договоров. */
        const a = findApp(q.app);
        if (!a) return res.status(200).json({ ok: false, error: "unknown app" });
        const url = `${BASE}${a.path}/odata/standard.odata/$metadata`;
        const r = await fetch(url, { headers: { Authorization: authHeader() }, signal: AbortSignal.timeout(20000) });
        const text = await r.text();
        if (r.status !== 200) return res.status(200).json({ ok: false, status: r.status, error: text.slice(0, 300) });
        const re = new RegExp(`<EntityType Name="${String(q.entity)}"[\\s\\S]*?</EntityType>`);
        const m = re.exec(text);
        if (!m) return res.status(200).json({ ok: false, error: "entity not found" });
        const props = [...m[0].matchAll(/<Property Name="([^"]+)"/g)].map((x) => x[1]);
        const navs = [...m[0].matchAll(/<NavigationProperty Name="([^"]+)"/g)].map((x) => x[1]);
        return res.status(200).json({ ok: true, props, navs });
      }
      if (q.r === "entitynames" && q.app && q.prefix) {
        const a = findApp(q.app);
        if (!a) return res.status(200).json({ ok: false, error: "unknown app" });
        const url = `${BASE}${a.path}/odata/standard.odata/$metadata`;
        const r = await fetch(url, { headers: { Authorization: authHeader() }, signal: AbortSignal.timeout(20000) });
        const text = await r.text();
        if (r.status !== 200) return res.status(200).json({ ok: false, status: r.status, error: text.slice(0, 300) });
        const re = new RegExp(`<EntityType Name="(${String(q.prefix)}[^"]*)"`, "g");
        const names = [...text.matchAll(re)].map((x) => x[1]);
        return res.status(200).json({ ok: true, count: names.length, names });
      }
      if (q.r === "complextype" && q.app && q.name) {
        const a = findApp(q.app);
        if (!a) return res.status(200).json({ ok: false, error: "unknown app" });
        const url = `${BASE}${a.path}/odata/standard.odata/$metadata`;
        const r = await fetch(url, { headers: { Authorization: authHeader() }, signal: AbortSignal.timeout(20000) });
        const text = await r.text();
        if (r.status !== 200) return res.status(200).json({ ok: false, status: r.status, error: text.slice(0, 300) });
        const re = new RegExp(`<ComplexType Name="${String(q.name)}"[\\s\\S]*?</ComplexType>`);
        const m = re.exec(text);
        if (!m) return res.status(200).json({ ok: false, error: "complextype not found" });
        const props = [...m[0].matchAll(/<Property Name="([^"]+)" Type="([^"]+)"/g)].map((x) => ({ name: x[1], type: x[2] }));
        return res.status(200).json({ ok: true, props });
      }
      return res.status(200).json({ ok: true, service: "Finpulse 1C bridge", routes: ["apps", "ping", "meta", "orgs", "counterparties", "nomenclature", "contracts"] });
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
      if (body && body.action === "execute_task" && body.num) {
        return res.status(200).json(await executeTaskIn1C(Number(body.num), authUser?.name, !!body.force));
      }
      if (body && body.action === "create_draft" && body.app && body.entity) {
        /* whitelist: entity должен быть одним из реальных типов документов БУ УЗ 3.0,
           а не произвольной строкой — иначе можно ушатать любое имя в OData
           (в т.ч. выдуманное AI-агентом) и получить непонятную 404. */
        const validEntities = new Set(Object.values(DOC_1C_TYPES));
        if (!validEntities.has(String(body.entity))) {
          return res.status(200).json({
            ok: false,
            error: `неизвестный тип документа «${body.entity}» — поддерживаются только: ${[...validEntities].join(", ")}`,
          });
        }
        const a = findApp(body.app);
        if (!a) return res.status(200).json({ ok: false, error: "unknown app" });
        return res.status(200).json(await createDraftDoc(a.path, String(body.entity), body.fields || {}));
      }
      if (body && body.action === "sync_orgs" && body.app) {
        const a = findApp(body.app);
        if (!a) return res.status(200).json({ ok: false, error: "unknown app" });
        return res.status(200).json(await syncOrgs(a.path, a.name, authUser?.name));
      }
      if (body && body.action === "sync_counterparties" && body.app) {
        const a = findApp(body.app);
        if (!a) return res.status(200).json({ ok: false, error: "unknown app" });
        return res.status(200).json(await syncCounterparties(a.path, a.name, authUser?.name));
      }
      if (body && body.action === "sync_nomenclature" && body.app) {
        const a = findApp(body.app);
        if (!a) return res.status(200).json({ ok: false, error: "unknown app" });
        return res.status(200).json(await syncNomenclature(a.path, a.name, authUser?.name));
      }
      if (body && body.action === "sync_contracts" && body.app) {
        const a = findApp(body.app);
        if (!a) return res.status(200).json({ ok: false, error: "unknown app" });
        return res.status(200).json(await syncContracts(a.path, a.name, authUser?.name));
      }
      return res.status(200).json({ ok: false, error: "unknown action" });
    }

    res.status(405).json({ ok: false });
  } catch (e) {
    console.error("1c api:", e);
    res.status(200).json({ ok: false, error: String(e).slice(0, 300) });
  }
};
