/* Клиентский мини-дашборд (задача #13 из бэклога): остаток/долги из 1С.
   Минимальный самостоятельный OData-клиент (те же BASE/логин/пароль, что
   и в api/1c.js) — не тянем сюда весь api/1c.js, чтобы не плодить лишние
   зависимости между эндпоинтами; логика идентична проверенной в api/1c.js. */
const { fetchWithRetry } = require("./httpRetry.js");

const BASE = process.env.ODATA_1C_BASE || "https://clobus.uz";
const LOGIN = process.env.ODATA_1C_LOGIN || "";
const PASSWORD = process.env.ODATA_1C_PASSWORD || "";

function authHeader() {
  return "Basic " + Buffer.from(`${LOGIN}:${PASSWORD}`).toString("base64");
}

async function odata(appPath, resource, params) {
  const url = `${BASE}${appPath}/odata/standard.odata/${resource}${params ? `?${params}` : ""}`;
  const r = await fetchWithRetry(() => fetch(url, {
    headers: { Authorization: authHeader(), Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  }));
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* xml/html */ }
  return { status: r.status, json, text };
}

function sumField(rows, field) {
  return (rows || []).reduce((s, r) => s + (Number(r[field]) || 0), 0);
}

/* Дебиторка клиента: выставленные счета + реализации по ЕГО ЖЕ организации
   внутри его собственной базы 1С (каждая база в DEFAULT_APPS — это база
   ОДНОГО клиента, поле "Организация" там — сам клиент, а "Контрагент" —
   уже ЕГО покупатели/поставщики). Поэтому фильтруем по Организация_Key,
   а не по конкретному контрагенту — это сумма по всем его клиентам сразу. */
async function getClientReceivables(appPath, orgRef) {
  if (!LOGIN || !PASSWORD) return { ok: false, error: "ODATA_1C_LOGIN/PASSWORD не заданы" };
  const filter = `Организация_Key eq guid'${orgRef}' and Posted eq true`;
  const select = "$select=СуммаДокумента,Date,Number&$top=1000&$format=json";

  const [invRes, realRes] = await Promise.all([
    odata(appPath, "Document_СчетНаОплатуПокупателю", `${select}&$filter=${filter}`),
    odata(appPath, "Document_РеализацияТоваровУслуг", `${select}&$filter=${filter}`),
  ]);

  if (invRes.status === 404 && realRes.status === 404) {
    return { ok: false, error: "Счета/реализации не включены в состав OData этой базы — настройте состав REST-сервиса" };
  }
  if (invRes.status === 401 || realRes.status === 401) return { ok: false, error: "auth: проверьте ODATA_1C_LOGIN/PASSWORD" };

  const invoiced = invRes.status === 200 ? sumField(invRes.json?.value, "СуммаДокумента") : null;
  const shipped = realRes.status === 200 ? sumField(realRes.json?.value, "СуммаДокумента") : null;

  return {
    ok: true,
    invoicedTotal: invoiced,
    shippedTotal: shipped,
    invoicesCount: invRes.json?.value?.length || 0,
    shipmentsCount: realRes.json?.value?.length || 0,
    note: "Сумма выставленных счетов и реализаций по данным 1С (Document_СчетНаОплатуПокупателю + Document_РеализацияТоваровУслуг). Платежи (Document_ПлатежноеПоручение) не вычтены — реквизит привязки контрагента в этом документе не зафиксирован против $metadata как надёжный для автоматического сопоставления, поэтому это не точный «остаток долга», а объём выставленных документов. За точной суммой к оплате обращайтесь к бухгалтеру.",
  };
}

/* Грубая оценка остатка денег: обороты по типовым кассовым/расчётным счетам
   с самого начала базы (широкий диапазон дат) — не настоящий текущий
   остаток (для этого нужны субконто, которые не публикуются через OData в
   этой конфигурации — см. getAccountTurnover в api/1c.js), а приблизительная
   оценка на основе доступных проводок. */
async function getCashEstimate(appPath) {
  if (!LOGIN || !PASSWORD) return { ok: false, error: "ODATA_1C_LOGIN/PASSWORD не заданы" };
  const accounts = ["5110", "5010", "5210"]; // касса / денежные средства / расчётный счёт (типовые коды НСБУ РУз)
  const from = "2015-01-01T00:00:00";
  const to = new Date().toISOString().slice(0, 19);
  const dateFilter = ` and Period ge datetime'${from}' and Period le datetime'${to}'`;
  const baseSelect = "$select=Сумма,AccountDr_Key,AccountCr_Key&$top=5000&$format=json";

  let anyOk = false;
  let net = 0;
  for (const code of accounts) {
    try {
      const [drRes, crRes] = await Promise.all([
        odata(appPath, "AccountingRegister_Хозрасчетный_RecordType", `${baseSelect}&$filter=AccountDr/Code eq '${code}'${dateFilter}`),
        odata(appPath, "AccountingRegister_Хозрасчетный_RecordType", `${baseSelect}&$filter=AccountCr/Code eq '${code}'${dateFilter}`),
      ]);
      if (drRes.status === 200 && crRes.status === 200) {
        anyOk = true;
        net += sumField(drRes.json?.value, "Сумма") - sumField(crRes.json?.value, "Сумма");
      }
    } catch (e) { /* пропускаем недоступный счёт */ }
  }
  if (!anyOk) return { ok: false, error: "Регистр бухгалтерии не опубликован в OData для этой базы" };
  return {
    ok: true,
    estimate: net,
    note: "Грубая оценка остатка по кассовым/расчётным счетам на основе всех доступных проводок с 2015 года — не заверенный текущий баланс (точная аналитика по субконто не публикуется через OData в этой конфигурации).",
  };
}

module.exports = { getClientReceivables, getCashEstimate };
