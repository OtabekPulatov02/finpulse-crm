/* Интеллектуальный выбор шаблона документа (roadmap: "AI автоматически
   определяет тип нужного документа / предлагает наиболее подходящий шаблон
   на основе истории клиента / автозаполняет реквизиты / спрашивает только
   недостающее"). Хранилище — Redis, тот же паттерн, что и RAG-база знаний
   (lib/rag.js): плоский список записей + set id'шников.

   Шаблон — это текст с плейсхолдерами вида {{organization}}, {{subject}}
   и т.д. requiredFields — список плейсхолдеров, без которых документ
   считается неполным (именно они уходят в missing и AI спрашивает
   пользователя ТОЛЬКО про них — остальное либо автозаполняется из 1С/CRM,
   либо агент сам вытаскивает из текста задачи и передаёт как fields). */

const DOCTPL_IDS_KEY = "doctpl:list";
const docTplKey = (id) => "doctpl:doc:" + id;
const usageKey = (company) => "doctpl:usage:" + String(company || "").toLowerCase().trim();
const counterKey = "doctpl:counter";

/* Дефолтные шаблоны — засеиваются один раз, если справочник ещё пуст (ничего
   не создавали через UI). Это ЧЕРНОВИКИ-СКЕЛЕТЫ с плейсхолдерами — не готовые
   юридические тексты для использования как есть, каждый явно помечен как
   требующий проверки бухгалтера/юриста перед отправкой контрагенту (см.
   renderTemplate/шаг confirm в draft_contract). */
const DEFAULT_TEMPLATES = [
  {
    name: "Договор оказания услуг", category: "Договоры",
    requiredFields: ["subject", "amount", "term"],
    body: `ДОГОВОР ОКАЗАНИЯ УСЛУГ {{number}}

г. Ташкент                                                    {{date}}

{{organization}} (ИНН {{organizationInn}}), именуемое в дальнейшем «Исполнитель»,
и {{counterparty}} (ИНН {{counterpartyInn}}), именуемое в дальнейшем «Заказчик»,
заключили настоящий договор о нижеследующем:

1. ПРЕДМЕТ ДОГОВОРА
{{subject}}

2. СУММА ДОГОВОРА
{{amount}}

3. СРОК ДЕЙСТВИЯ
{{term}}

4. РЕКВИЗИТЫ СТОРОН
Исполнитель: {{organization}}, ИНН {{organizationInn}}, р/с {{organizationAccount}}, МФО {{organizationMfo}}, банк {{organizationBank}}
Заказчик: {{counterparty}}, ИНН {{counterpartyInn}}

--- ЧЕРНОВИК: проверьте все поля и юридические формулировки перед подписанием и отправкой контрагенту. ---`,
  },
  {
    name: "Договор поставки", category: "Договоры",
    requiredFields: ["subject", "amount", "term"],
    body: `ДОГОВОР ПОСТАВКИ {{number}}

г. Ташкент                                                    {{date}}

{{organization}} (ИНН {{organizationInn}}), именуемое в дальнейшем «Поставщик»,
и {{counterparty}} (ИНН {{counterpartyInn}}), именуемое в дальнейшем «Покупатель»,
заключили настоящий договор о нижеследующем:

1. ПРЕДМЕТ ДОГОВОРА (наименование, количество товара)
{{subject}}

2. ЦЕНА И ПОРЯДОК РАСЧЁТОВ
{{amount}}

3. СРОК ПОСТАВКИ / СРОК ДЕЙСТВИЯ ДОГОВОРА
{{term}}

4. РЕКВИЗИТЫ СТОРОН
Поставщик: {{organization}}, ИНН {{organizationInn}}, р/с {{organizationAccount}}, МФО {{organizationMfo}}, банк {{organizationBank}}
Покупатель: {{counterparty}}, ИНН {{counterpartyInn}}

--- ЧЕРНОВИК: проверьте все поля и юридические формулировки перед подписанием и отправкой контрагенту. ---`,
  },
  {
    name: "Договор аренды", category: "Договоры",
    requiredFields: ["subject", "amount", "term"],
    body: `ДОГОВОР АРЕНДЫ {{number}}

г. Ташкент                                                    {{date}}

{{organization}} (ИНН {{organizationInn}}), именуемое в дальнейшем «Арендодатель»,
и {{counterparty}} (ИНН {{counterpartyInn}}), именуемое в дальнейшем «Арендатор»,
заключили настоящий договор о нижеследующем:

1. ПРЕДМЕТ ДОГОВОРА (объект аренды, адрес/описание)
{{subject}}

2. АРЕНДНАЯ ПЛАТА
{{amount}}

3. СРОК АРЕНДЫ
{{term}}

4. РЕКВИЗИТЫ СТОРОН
Арендодатель: {{organization}}, ИНН {{organizationInn}}, р/с {{organizationAccount}}, МФО {{organizationMfo}}, банк {{organizationBank}}
Арендатор: {{counterparty}}, ИНН {{counterpartyInn}}

--- ЧЕРНОВИК: проверьте все поля и юридические формулировки перед подписанием и отправкой контрагенту. ---`,
  },
  {
    name: "Дополнительное соглашение", category: "Договоры",
    requiredFields: ["subject"],
    body: `ДОПОЛНИТЕЛЬНОЕ СОГЛАШЕНИЕ {{number}}
к договору между {{organization}} и {{counterparty}}

г. Ташкент                                                    {{date}}

Стороны договорились внести в договор следующие изменения:

{{subject}}

Остальные условия договора остаются без изменений.

РЕКВИЗИТЫ СТОРОН
{{organization}}, ИНН {{organizationInn}}
{{counterparty}}, ИНН {{counterpartyInn}}

--- ЧЕРНОВИК: проверьте все поля и юридические формулировки перед подписанием и отправкой контрагенту. ---`,
  },
];

async function seedDefaultsIfEmpty(redis) {
  const ids = (await redis.smembers(DOCTPL_IDS_KEY)) || [];
  if (ids.length) return;
  for (const t of DEFAULT_TEMPLATES) {
    await addTemplate(redis, { ...t, by: "система (дефолт)" });
  }
}

async function listTemplates(redis) {
  await seedDefaultsIfEmpty(redis);
  const ids = (await redis.smembers(DOCTPL_IDS_KEY)) || [];
  if (!ids.length) return [];
  const docs = (await redis.mget(...ids.map(docTplKey))) || [];
  return docs.filter(Boolean).sort((a, b) => (a.name || "").localeCompare(b.name || "", "ru"));
}

async function getTemplate(redis, id) {
  if (!id) return null;
  return await redis.get(docTplKey(id));
}

async function addTemplate(redis, { name, category, body, requiredFields, by }) {
  const id = "dt" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const doc = {
    id,
    name: String(name || "").trim(),
    category: String(category || "").trim() || "Другое",
    body: String(body || ""),
    requiredFields: Array.isArray(requiredFields) ? requiredFields.filter(Boolean) : [],
    createdAt: new Date().toISOString(),
    by: by || "CRM",
  };
  await redis.set(docTplKey(id), doc);
  await redis.sadd(DOCTPL_IDS_KEY, id);
  return doc;
}

async function updateTemplate(redis, id, patch) {
  const doc = await getTemplate(redis, id);
  if (!doc) return null;
  const next = { ...doc, ...patch, id: doc.id, updatedAt: new Date().toISOString() };
  await redis.set(docTplKey(id), next);
  return next;
}

async function deleteTemplate(redis, id) {
  await redis.del(docTplKey(id));
  await redis.srem(DOCTPL_IDS_KEY, id);
}

/* Smart Template Selection: смотрим, какой шаблон чаще всего использовался
   именно для этого клиента раньше — самый частый и есть "предложенный".
   Если истории нет (новый клиент/первый договор) — suggestion будет null,
   и агент должен показать полный список на выбор, как в спеке. */
async function suggestTemplateForClient(redis, company) {
  const history = (await redis.get(usageKey(company))) || [];
  if (!Array.isArray(history) || !history.length) return null;
  const counts = new Map();
  for (const h of history) counts.set(h.templateId, (counts.get(h.templateId) || 0) + 1);
  let bestId = null, bestCount = 0;
  for (const [id, c] of counts) if (c > bestCount) { bestId = id; bestCount = c; }
  if (!bestId) return null;
  const tpl = await getTemplate(redis, bestId);
  if (!tpl) return null;
  return { templateId: bestId, name: tpl.name, usedCount: bestCount };
}

async function recordTemplateUsage(redis, company, templateId) {
  if (!company || !templateId) return;
  const key = usageKey(company);
  const history = (await redis.get(key)) || [];
  const next = (Array.isArray(history) ? history : []).concat([{ templateId, at: new Date().toISOString() }]).slice(-50);
  await redis.set(key, next, { ex: 60 * 60 * 24 * 730 });
}

/* Автономер договора — сквозной счётчик, не привязан к 1С (это не
   бухгалтерский документ 1С, а юридический текст самого договора). */
async function nextContractNumber(redis) {
  const n = await redis.incr(counterKey);
  const year = new Date().getFullYear();
  return `№${n}-${year}`;
}

/* Известные автозаполняемые поля — из карточки клиента (реквизиты
   организации, синканные из 1С через syncOrgs) + контрагента (если
   передан). director/subject/amount/term намеренно не входят сюда —
   в системе нет источника данных на директора, а предмет/сумму/срок
   почти всегда должен вытащить из текста задачи сам агент (или спросить
   у пользователя, если правда не хватает). */
function autofillFromClient(client, counterparty) {
  const filled = {};
  if (client) {
    if (client.company) filled.organization = client.company;
    if (client.inn) filled.organizationInn = client.inn;
    if (client.bankAccount) filled.organizationAccount = client.bankAccount;
    if (client.mfo) filled.organizationMfo = client.mfo;
    if (client.bank) filled.organizationBank = client.bank;
  }
  if (counterparty) {
    if (counterparty.name) filled.counterparty = counterparty.name;
    if (counterparty.inn) filled.counterpartyInn = counterparty.inn;
  }
  filled.date = new Date().toLocaleDateString("ru-RU");
  return filled;
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function templatePlaceholders(body) {
  const set = new Set();
  let m;
  const re = new RegExp(PLACEHOLDER_RE);
  while ((m = re.exec(String(body || "")))) set.add(m[1]);
  return [...set];
}

/* Рендер: заменяет все известные плейсхолдеры, оставшиеся незаполненные
   (которых нет в fields) явно помечает [НЕ ЗАПОЛНЕНО: xxx], чтобы черновик
   никогда не выглядел готовым к подписанию, если чего-то не хватает —
   бухгалтер должен увидеть пробел, а не тихо потерянное поле. */
function renderTemplate(body, fields) {
  return String(body || "").replace(PLACEHOLDER_RE, (_, key) => {
    const v = fields ? fields[key] : undefined;
    return (v === undefined || v === null || v === "") ? `[НЕ ЗАПОЛНЕНО: ${key}]` : String(v);
  });
}

function missingRequired(template, fields) {
  const req = Array.isArray(template.requiredFields) ? template.requiredFields : [];
  return req.filter((k) => fields[k] === undefined || fields[k] === null || fields[k] === "");
}

module.exports = {
  listTemplates, getTemplate, addTemplate, updateTemplate, deleteTemplate,
  suggestTemplateForClient, recordTemplateUsage, nextContractNumber,
  autofillFromClient, templatePlaceholders, renderTemplate, missingRequired,
};
