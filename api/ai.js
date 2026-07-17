/* ============================================================
   Finpulse CRM — AI-эндпоинт (классификация, черновики).

   GET  /api/ai?r=ping        → статус ключа/модели (+тестовый вызов ?test=1)
   GET  /api/ai?r=settings    → тумблеры функций
   POST /api/ai {action:"settings_save", settings}
   POST /api/ai {action:"classify", text}        → категория/подкатегория
   POST /api/ai {action:"draft", num}            → черновик операции → task.aiDraft
   POST /api/ai {action:"summarize", num}        → выжимка переписки → task.aiSummary
   ============================================================ */

const { Redis } = require("@upstash/redis");
const { chat, classifyTask, draftFromTask, summarizeThread } = require("../lib/ai.js");
const { buildClientContext, getMemory, addMemory, getUsage, logUsage } = require("../lib/brain.js");
const { CONSTITUTION, DEFAULT_CATEGORIES } = require("../lib/knowledge.js");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const DEFAULT_SETTINGS = { classify: true, drafts: true, summarize: true, autoWork: false };

async function logEvent(event, data) {
  try {
    await redis.lpush("logs:crm", JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
    await redis.ltrim("logs:crm", 0, 499);
  } catch (e) { /* noop */ }
}


/* ---------------- AI-агент супер-админа ----------------
   Инструменты — существующие эндпоинты /api/crm и /api/1c,
   вызываются с JWT самого админа: агент умеет всё то же,
   что и админ в интерфейсе, и ничего сверх этого. */

const SELF = process.env.CRM_API_ORIGIN || "https://finpulse-crm.vercel.app";

const AGENT_SYSTEM = CONSTITUTION + `

Ты — операционный AI-ассистент CRM Finpulse (бухгалтерская компания, Узбекистан, суммы в UZS).
Ты выполняешь поручения супер-админа через инструменты crm_get/crm_post/onec_get/onec_post.

Справка по API (crm_get query / crm_post body):
GET: r=ping | r=tasks | r=clients | r=client&id=<id> | r=usage | r=tariffs | r=logs&src=telegram|crm | r=pending | r=access_requests | r=employees | r=calendar | r=calendar_events | r=bot_settings | r=bot_categories | r=bot_positions
POST actions:
- {action:"status", num, status:"new|in_progress|done|cancelled", assignee} — статус задачи (уведомит клиента в Telegram)
- {action:"task_create", company|clientId, text, assignee?, dueDate?"YYYY-MM-DD"} / {action:"task_update", num, patch:{text?,assignee?,dueDate?}} / {action:"task_delete", num}
- {action:"client_create", company, phone?, position?, tariff?, assignedTo?} / {action:"client_update", id, patch:{...поля карточки, вкл. inn,fullName,pinfl,vatCode,taxSystem,bank,mfo,bankAccount,address,director,taxOffice,tariff,status}} / {action:"client_delete", id}
- {action:"tariffs_save", tariffs:[{id,name,price,monthlyLimit,overPackOps,overPackPrice}]} | {action:"ops_pack_add", clientId, packs}
- {action:"bot_settings_save", settings:{slaHours,workStart,workEnd}} | {action:"bot_categories_save", categories:[{id,name,subs[]}]} | {action:"bot_positions_save", positions:[...]}
- {action:"access_request_resolve", id, approve:true|false}
- {action:"employee_create", name, phone, role:"admin|accountant"} / {action:"employee_update", id, patch} / {action:"employee_reset_password", id} / {action:"employee_delete", id}
- {action:"calendar_event_create", type:"tax|pay", title, company?, date, repeat?, remindDays?} / _update / _delete
onec_get: r=apps | r=ping | r=meta&app=<code> | r=orgs&app=<code> | r=counterparties&app=<code> | r=nomenclature&app=<code> | r=contracts&app=<code> | r=turnover&app=<code>&account=<код счёта, напр. 5110>&from=YYYY-MM-DD&to=YYYY-MM-DD — обороты по счёту за период (дебет/кредит/нетто); БЕЗ разбивки по контрагентам (субконто по контрагентам не публикуется через OData в этой конфигурации 1С) | r=reports[&app=<code>] — календарь регламентированной отчётности: по каждому виду отчёта (НДФЛ+соцналог, налог на прибыль, баланс и т.п.) последний подготовленный период и ВЫВЕДЕННЫЙ из периодичности следующий ожидаемый период (nextExpectedPeriodEnd) — это НЕ официальный срок сдачи из 1С (1С его не хранит отдельным полем), а расчёт по истории; всегда сообщай пользователю эту оговорку, когда показываешь эти данные, и предлагай синк (sync_reports) если данные старые
ВАЖНО: <code> — это числовой код приложения 1С (напр. "46516"), а НЕ название компании. Если знаешь только название компании/клиента — сначала вызови onec_get r=apps, найди в списке нужную запись (по полю name) и возьми её code, только потом используй этот code в app=.
onec_post: {action:"sync_orgs", app} | {action:"sync_counterparties", app} | {action:"sync_nomenclature", app} | {action:"sync_contracts", app} | {action:"execute_task", num, force?:true, counterpartyRef?:string, confirmNewCounterparty?:true} — создаёт НЕПРОВЕДЁННЫЙ документ в 1С базе клиента из AI-черновика задачи (главная операция!). execute_task сам заполняет реальные поля документа: сумму/НДС (из draft.amount и draft.vat), Контрагент_Key и ДоговорКонтрагента_Key (если контрагент синкан), строки товаров/услуг (если заполнен draft.items). Контрагент проверяется по ИНН (надёжнее) и только потом по названию — ИНН из заявки передавай в черновик как counterpartyInn, если он есть. Контрагента НИКОГДА не создавай молча по одному лишь несовпадению имени: если execute_task вернул counterpartyAmbiguous:true — либо есть suggestions (похожие варианты, каждый с ref) — спроси пользователя через ask_user, какой из них подходит, и при выборе вызови execute_task повторно с counterpartyRef:<ref выбранного варианта>; либо suggestions пустой и noMatch:true — спроси у пользователя явно, точно ли это новый контрагент, и только при явном "да" вызови execute_task с confirmNewCounterparty:true (это единственный способ создать новую карточку контрагента — никогда не делай это по умолчанию).
Пайплайн выполнения задачи клиента в 1С: 1) crm_get r=tasks — найди задачу; 2) ai_draft {num} — подготовь черновик операции; 3) onec_post {action:"execute_task", num} — создай непроведённый документ в 1С базе клиента; 4) crm_post {action:"status", num, status:"in_progress", assignee:"AI-бухгалтер"} и сообщи, что бухгалтеру осталось проверить и провести; 5) ОБЯЗАТЕЛЬНО следом вызови crm_post {action:"task_message_send", num, text:"<короткая сводка: какой документ создан, номер/сумма/контрагент>"} — это записывает результат в ленту задачи, чтобы бухгалтер видел историю работы ИИ прямо в CRM, а не только в Telegram. Тот же шаг 5 делай и при неудаче (кратко опиши, что не получилось и почему). Если execute_task вернул duplicate:true — значит по этой же компании/типу/сумме уже создан документ за последние 24ч (номер задачи указан в ответе); НЕ вызывай сразу повторно с force — сначала вызови ask_user, спроси у пользователя, это действительно отдельная операция или повтор, и только после явного подтверждения вызови execute_task снова с force:true.
ВАЖНО про 1С: НИКОГДА не вызывай onec_post {action:"create_draft", ...} напрямую и никогда не придумывай/не угадывай имена сущностей 1С (entity) сам — единственный поддерживаемый способ создать документ в 1С это пайплайн execute_task выше, который сам подставляет проверенное имя документа по типу черновика.
Поддерживаемые типы черновиков документов 1С (создание НЕПРОВЕДЁННОГО документа в базе клиента): платёж исходящий/входящий, ЭСФ (счёт-фактура выданный), счёт на оплату, поступление товаров/услуг, реализация товаров/услуг, акт сверки, доверенность, приём на работу, увольнение, отпуск. Все эти типы ПОДДЕРЖИВАЮТСЯ через execute_task.
Кадровые документы (hr_leave/hr_hire/hr_fire) требуют draft.employee (точное ФИО сотрудника) — резолвится по синку сотрудников (sync_employees), сначала точное совпадение. Сотрудника НИКОГДА не создавай автоматически (в отличие от контрагента) — если execute_task вернул employeeAmbiguous:true, спроси пользователя (suggestions — похожие варианты с ref) и вызови execute_task повторно с employeeRef:<ref> при выборе, либо уточни точное ФИО. Для hr_leave также передавай draft.hrDate (дата начала отпуска) и draft.hrDays (число дней); для hr_hire/hr_fire — draft.hrDate (дата приёма/увольнения).
НЕ путай это с самим ЭДО (Didox) — фактическая отправка документа контрагенту через систему электронного документооборота и получение подписи НЕ реализована (нет интеграции с Didox API), это отдельная задача. Если просят создать документ одного из поддерживаемых типов (в т.ч. ЭСФ) — выполняй через execute_task как обычно. Если явно просят отправить/подписать через ЭДО/Didox — скажи, что этой интеграции пока нет, и не пытайся выполнить это через 1С.

Правила:
1. Всегда сначала читай данные (crm_get), потом действуй.
2. Деструктивные действия (delete, сброс пароля, массовые изменения) — только после явного подтверждения в диалоге. Если его нет — опиши, что собираешься сделать, и спроси.
3. Отвечай кратко, по-русски, с итогом что сделано. Числа/суммы — как в данных.
4. Если данных нет или API вернул ошибку — скажи честно.
5. Если поручение неоднозначно (неясно какую задачу/клиента/тип документа/сумму имеют в виду, или это заметно влияющее действие — создание документа в 1С, изменение статуса, удаление, массовая операция) — НЕ угадывай и НЕ выполняй сразу. Вызови ask_user с коротким вопросом и 2-4 конкретными вариантами ответа (пользователь всегда может вместо кнопки написать свой вариант текстом — это встроено в интерфейс, отдельный вариант "другое" добавлять не нужно). После ask_user сразу останавливайся и жди ответа пользователя следующим сообщением — не вызывай другие инструменты в этом же ответе.`;

const AGENT_TOOLS = [
  { type: "function", function: { name: "crm_get", description: "GET-запрос к /api/crm. Аргумент query — строка после ?, напр. \"r=tasks\"", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "crm_post", description: "POST к /api/crm. body — объект действия, напр. {\"action\":\"status\",\"num\":106,\"status\":\"done\"}", parameters: { type: "object", properties: { body: { type: "object" } }, required: ["body"] } } },
  { type: "function", function: { name: "onec_get", description: "GET к /api/1c (интеграция 1С). query напр. \"r=ping\"", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "onec_post", description: "POST к /api/1c, напр. {\"action\":\"sync_orgs\",\"app\":\"46516\"}", parameters: { type: "object", properties: { body: { type: "object" } }, required: ["body"] } } },
  { type: "function", function: { name: "ai_draft", description: "Сгенерировать AI-черновик операции для задачи CRM (сохраняется в task.aiDraft). Аргумент num — номер задачи.", parameters: { type: "object", properties: { num: { type: "number" } }, required: ["num"] } } },
  { type: "function", function: { name: "memory_get", description: "Долгосрочная память по компании клиента (факты).", parameters: { type: "object", properties: { company: { type: "string" } }, required: ["company"] } } },
  { type: "function", function: { name: "memory_add", description: "Записать устойчивый факт о компании в память (аренда, банк, договорённости).", parameters: { type: "object", properties: { company: { type: "string" }, fact: { type: "string" } }, required: ["company", "fact"] } } },
  { type: "function", function: { name: "ask_user", description: "Задать уточняющий вопрос пользователю ПЕРЕД выполнением неоднозначного или значимого действия (создание документа в 1С, изменение статуса, удаление, массовая операция и т.п.). Останавливает выполнение до ответа пользователя.", parameters: { type: "object", properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" }, description: "2-4 коротких конкретных варианта ответа" } }, required: ["question", "options"] } } },
];

async function callTool(name, args, authHeaders) {
  const base = name.startsWith("crm") ? SELF + "/api/crm" : SELF + "/api/1c";
  try {
    let r;
    if (name.endsWith("_get")) {
      r = await fetch(base + "?" + String(args.query || ""), { headers: authHeaders, signal: AbortSignal.timeout(20000) });
    } else {
      /* модель иногда присылает поля действия на верхнем уровне (без обёртки body) —
         подстрахуемся и в этом случае используем сами args как тело запроса. */
      const payload = (args.body && typeof args.body === "object") ? args.body : args;
      r = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify(payload || {}),
        signal: AbortSignal.timeout(25000),
      });
    }
    const text = await r.text();
    return text.slice(0, 6000);
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e).slice(0, 200) });
  }
}

async function runAgent(messages, authHeaders) {
  const KEY = process.env.OPENAI_API_KEY;
  const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const convo = [{ role: "system", content: AGENT_SYSTEM }, ...messages.slice(-20)];
  const steps = [];
  for (let i = 0; i < 8; i++) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, messages: convo, tools: AGENT_TOOLS, temperature: 0.1, max_tokens: 900 }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    void logUsage(redis, data.usage);
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("empty completion");
    convo.push(msg);
    if (!msg.tool_calls || !msg.tool_calls.length) {
      return { reply: msg.content || "(пустой ответ)", steps };
    }
    let askResult = null;
    for (const tc of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch (e) { /* noop */ }
      let result;
      if (tc.function.name === "ask_user") {
        const options = Array.isArray(args.options) ? args.options.map(String).slice(0, 4) : [];
        result = JSON.stringify({ ok: true, note: "вопрос показан пользователю, жду ответа" });
        askResult = { reply: String(args.question || "Уточните, пожалуйста"), steps, askOptions: options, awaitingConfirmation: true };
      } else if (tc.function.name === "memory_get") {
        result = JSON.stringify({ ok: true, memory: await getMemory(redis, String(args.company || "")) });
      } else if (tc.function.name === "memory_add") {
        const added = await addMemory(redis, String(args.company || ""), String(args.fact || ""), "AI-агент");
        result = JSON.stringify({ ok: added });
      } else if (tc.function.name === "ai_draft") {
        try {
          const task = await redis.get("task:" + Number(args.num));
          if (!task) { result = JSON.stringify({ ok: false, error: "task not found" }); }
          else {
            let clientInfo = null;
            try {
              const cid = await redis.get("clientcompany:" + String(task.company || "").toLowerCase().replace(/[^a-zа-яё0-9]+/gi, " ").trim());
              if (cid) clientInfo = await redis.get("client:" + cid);
            } catch (e) { /* noop */ }
            const draft = await draftFromTask(task, clientInfo, { redis });
            if (draft) {
              task.aiDraft = { ...draft, generatedAt: new Date().toISOString(), by: "AI-агент" };
              await redis.set("task:" + Number(args.num), task);
              result = JSON.stringify({ ok: true, draft: task.aiDraft });
            } else result = JSON.stringify({ ok: false, error: "не удалось подготовить черновик" });
          }
        } catch (e) { result = JSON.stringify({ ok: false, error: String(e).slice(0, 200) }); }
      } else {
        result = await callTool(tc.function.name, args, authHeaders);
      }
      steps.push({ tool: tc.function.name, args: JSON.stringify(args).slice(0, 200), ok: !result.includes('"ok":false') });
      convo.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
    if (askResult) return askResult;
  }
  return { reply: "Достигнут лимит шагов — уточните задачу или разбейте её на части.", steps };
}


/* ---------------- Темы AI-чата (история диалогов суперадмина) ---------------- */
async function listChats() {
  const rows = (await redis.lrange("aichat:threads", 0, 29)) || [];
  return rows.map((r) => { try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } }).filter(Boolean);
}
async function saveChatMeta(meta) {
  const all = await listChats();
  const rest = all.filter((c) => c.id !== meta.id);
  await redis.del("aichat:threads");
  const next = [meta, ...rest].slice(0, 30);
  if (next.length) await redis.rpush("aichat:threads", ...next.map((c) => JSON.stringify(c)));
  /* обрезаем хвост: удаляем сообщения тем, выпавших из списка */
  for (const gone of all.slice(29)) { try { await redis.del("aichat:msgs:" + gone.id); } catch (e) { /* noop */ } }
}
/* Короткое название диалога (3-6 слов), генерируется ИИ по первому вопросу
   и первому ответу — как в обычных чат-интерфейсах, вместо простого обрезания
   сырого текста сообщения. Если вызов не удался (нет ключа, таймаут и т.п.) —
   тихо откатываемся на старое поведение (обрезанный текст первого сообщения). */
async function generateChatTitle(userText, replyText) {
  const fallback = String(userText || "Диалог").slice(0, 60);
  if (!process.env.OPENAI_API_KEY) return fallback;
  try {
    const res = await chat([
      { role: "system", content: 'Придумай короткое название диалога (3-6 слов, на русском, без кавычек и точки в конце) по сути вопроса пользователя и ответа. Ответ строго JSON: {"title": "..."}.' },
      { role: "user", content: `Вопрос: ${String(userText || "").slice(0, 500)}

Ответ: ${String(replyText || "").slice(0, 500)}` },
    ], { maxTokens: 30, timeoutMs: 8000 });
    const title = String(res?.title || "").trim().slice(0, 60);
    return title || fallback;
  } catch (e) {
    return fallback;
  }
}

async function persistChat(chatId, messages, reply, steps) {
  const id = chatId || "ch" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const stored = [...messages, { role: "assistant", content: reply, steps: steps || [] }].slice(-60);
  await redis.set("aichat:msgs:" + id, stored);
  const firstUser = stored.find((m) => m.role === "user");
  /* Название задаём только на СОЗДАНИИ диалога (по первому вопросу/ответу) —
     при последующих сообщениях в тот же диалог название не пересчитываем,
     чтобы оно не "прыгало" на каждый новый вопрос в чате. */
  const isNewChat = !chatId;
  const existing = isNewChat ? null : (await listChats()).find((c) => c.id === id);
  const title = existing
    ? existing.title
    : await generateChatTitle(firstUser?.content, reply);
  await saveChatMeta({
    id,
    title,
    updatedAt: new Date().toISOString(),
    count: stored.length,
  });
  return id;
}

/* ============================================================
   Автономный режим («Автономный ИИ-бухгалтер», тумблер в настройках AI).
   Срабатывает сразу после создания новой задачи (вызывается из bot.js и
   crm.js): готовит черновик, пытается сам создать непроведённый документ
   в 1С, отчитывается в группе бухгалтеров (реплаем на карточку задачи) и
   в ленте задачи. Если не уверен — задаёт уточняющий вопрос реплаем в
   группе и ждёт ответа (см. обработку в bot.js по ключу "aiq:<msgId>").
   ============================================================ */

const AUTOWORK_MONEY_TYPES = new Set(["payment_out", "payment_in", "invoice_esf", "schet", "postuplenie", "realizatsiya", "act_sverki"]);
const ENTITY_RU_NAMES = {
  "Document_СчетФактураВыданный": "Счёт-фактура выданный",
  "Document_ПлатежноеПоручение": "Платёжное поручение",
  "Document_СчетНаОплатуПокупателю": "Счёт на оплату",
  "Document_ПоступлениеТоваровУслуг": "Поступление товаров/услуг",
  "Document_РеализацияТоваровУслуг": "Реализация товаров/услуг",
  "Document_ДокументРасчетовСКонтрагентом": "Акт сверки",
  "Document_Доверенность": "Доверенность",
  "Document_ПриемНаРаботу": "Приём на работу",
  "Document_Увольнение": "Увольнение",
  "Document_Отпуск": "Отпуск",
};

function normCompanyLocal(str) {
  return String(str || "").toLowerCase().replace(/[^a-zа-яё0-9]+/gi, " ").trim();
}

function mintInternalToken() {
  const JWT_SECRET = process.env.JWT_SECRET || process.env.CRM_JWT_SECRET || "";
  if (!JWT_SECRET) return null;
  const jwt = require("jsonwebtoken");
  return jwt.sign({ role: "admin", name: "AI-бухгалтер (авто)" }, JWT_SECRET, { algorithm: "HS256", expiresIn: "3m" });
}

async function internalCrmPost(body) {
  const token = mintInternalToken();
  const r = await fetch(`${SELF}/api/crm`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(process.env.CRM_API_KEY ? { "x-api-key": process.env.CRM_API_KEY } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  return r.json().catch(() => ({ ok: false, error: "bad json" }));
}

async function internal1cPost(body) {
  const token = mintInternalToken();
  const r = await fetch(`${SELF}/api/1c`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return r.json().catch(() => ({ ok: false, error: "bad json" }));
}

/* Прямая отправка в Telegram-группу бухгалтеров (не через bot.js — тот же
   токен и та же логика подхвата migrate_to_chat_id при апгрейде группы). */
async function tgGroupSend(payload) {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!TOKEN) return null;
  let group = await redis.get("group");
  if (!group) return null;
  const call = (chatId) =>
    fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
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
  return resp && resp.ok ? resp.result : null;
}

function escapeHtmlLocal(s) {
  return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

async function pushThreadEntry(num, text) {
  try {
    const task = await redis.get("task:" + num);
    if (!task) return;
    task.thread = Array.isArray(task.thread) ? task.thread : [];
    task.thread.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      from: "staff",
      by: "AI-бухгалтер",
      text,
      fileIndex: null,
    });
    if (task.thread.length > 200) task.thread = task.thread.slice(-200);
    task.updatedAt = new Date().toISOString();
    await redis.set("task:" + num, task);
  } catch (e) { /* лента не критична */ }
}

/* Лёгкая нечёткая оценка похожести названий контрагентов — та же эвристика,
   что и в api/1c.js (подстрока + пересечение слов), нужна здесь, чтобы понять,
   на какой из предложенных вариантов бухгалтер ответил в группе. */
function fuzzyScoreLocal(a, b) {
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

const NEW_COUNTERPARTY_RE = /нов(ый|ая|ого)\s*(контрагент|клиент|компани)|созда(й|ть|ем|йте)|нет в списке|нет такого|not in (the )?list|new (client|company|counterparty)/i;
const CONFIRM_YES_RE = /^(да|ага|верно|так|точно|yes|confirm|подтвержда)/i;
const INN_ONLY_RE = /^\d{9}$|^\d{14}$/;

/* Короткий токен для callback_data инлайн-кнопки (Telegram ограничивает
   callback_data 64 байтами, поэтому сам вариант ответа не помещается —
   храним его в Redis по токену и на нажатии кнопки подставляем как обычный
   текстовый ответ в тот же конвейер runAutoWork, что и при реплае текстом). */
function makeAiqToken() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

async function storeAiqButton(num, kind, value, suggestions) {
  const token = makeAiqToken();
  try {
    await redis.set("aiqb:" + token, { num, kind, value, suggestions: suggestions || [] }, { ex: 3 * 24 * 3600 });
  } catch (e) { /* noop */ }
  return token;
}

/* Строит инлайн-клавиатуру "табами" из вариантов 1С — по кнопке на вариант,
   плюс отдельные кнопки для да/нет-подтверждений. Каждая кнопка — готовый
   ответ, бухгалтеру не нужно печатать вручную. Если подставить нечего
   (обычный уточняющий вопрос без вариантов) — клавиатуры не будет, ответ
   остаётся обычным текстовым реплаем. */
async function buildAiqKeyboard(num, kind, suggestions) {
  const rows = [];
  if ((kind === "counterparty" || kind === "employee") && suggestions && suggestions.length) {
    for (const s of suggestions) {
      const token = await storeAiqButton(num, kind, s.name, suggestions);
      const label = String(s.name || "").slice(0, 60);
      rows.push([{ text: label, callback_data: "aiqb:" + token }]);
    }
  } else if (kind === "confirm_new") {
    const token = await storeAiqButton(num, kind, "да, новый", []);
    rows.push([{ text: "✅ Да, это новый контрагент — создать карточку", callback_data: "aiqb:" + token }]);
  } else if (kind === "duplicate") {
    const token = await storeAiqButton(num, kind, "да", []);
    rows.push([{ text: "✅ Да, всё равно продолжить", callback_data: "aiqb:" + token }]);
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
}

async function askClarificationInGroup(num, task, questionText, kind, suggestions) {
  const replyMarkup = await buildAiqKeyboard(num, kind, suggestions).catch(() => undefined);
  const msg = await tgGroupSend({
    text: `🤖 <b>Задача №${num}</b> — нужна ваша помощь

${escapeHtmlLocal(questionText)}

<i>Нажмите кнопку с нужным вариантом ниже, или ответьте реплаем на это сообщение своим текстом — я продолжу работу над задачей.</i>`,
    parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    ...(task.gmsg ? { reply_to_message_id: task.gmsg } : {}),
  });
  if (msg) {
    try {
      await redis.set("aiq:" + msg.message_id, { num, kind: kind || "generic", suggestions: suggestions || [] }, { ex: 3 * 24 * 3600 });
    } catch (e) { /* noop */ }
  }
  /* Дублируем состояние ожидания по номеру задачи (не только по message_id
     Telegram-сообщения) — это позволяет бухгалтеру ответить на уточнение
     прямо в чате задачи в CRM, а не только реплаем в Telegram-группе. */
  try {
    await redis.set("aiq_task:" + num, { kind: kind || "generic", suggestions: suggestions || [] }, { ex: 3 * 24 * 3600 });
  } catch (e) { /* noop */ }
  await pushThreadEntry(num, `🤖 Уточняю в группе бухгалтеров: ${questionText}`);
  await logEvent("ai_autowork_asked", { num, kind: kind || "generic" });
  return { ok: true, asked: true, question: questionText };
}

async function reportExecSuccess(num, task, draft, execRes) {
  try { await redis.del("aiq_task:" + num); } catch (e) { /* noop */ }
  const entityName = ENTITY_RU_NAMES[execRes.entity] || execRes.entity;
  const summary =
    `✅ Задача №${num} — документ подготовлен в 1С

` +
    `📄 ${entityName}${execRes.number ? " №" + execRes.number : ""}
` +
    (draft.amount ? `💰 Сумма: ${Number(draft.amount).toLocaleString("ru-RU")} UZS
` : "") +
    (draft.counterparty ? `🤝 Контрагент: ${draft.counterparty}
` : "") +
    (execRes.note ? `⚠️ ${execRes.note}
` : "") +
    `
👉 Осталось бухгалтеру: проверить документ в 1С и провести/отправить.`;
  await tgGroupSend({
    text: escapeHtmlLocal(summary),
    ...(task.gmsg ? { reply_to_message_id: task.gmsg } : {}),
  });
  await pushThreadEntry(num, summary);
  await logEvent("ai_autowork_done", { num, entity: execRes.entity, ref: execRes.ref });
  return { ok: true, executed: true, entity: execRes.entity, ref: execRes.ref, number: execRes.number };
}

async function reportExecBlocked(num, task, errorText) {
  try { await redis.del("aiq_task:" + num); } catch (e) { /* noop */ }
  const blockedText = `⚠️ Задача №${num} — не смог выполнить автоматически: ${errorText || "неизвестная ошибка"}.

👉 Нужна ручная обработка бухгалтером.`;
  await tgGroupSend({
    text: escapeHtmlLocal(blockedText),
    ...(task.gmsg ? { reply_to_message_id: task.gmsg } : {}),
  });
  await pushThreadEntry(num, blockedText);
  await logEvent("ai_autowork_blocked", { num, error: errorText });
  return { ok: false, blocked: true, error: errorText };
}

/* Главная функция автономного режима. extraContext — если это повторный
   вызов после ответа бухгалтера на уточняющий вопрос (см. bot.js).
   aiqInfo — { kind: "counterparty"|"confirm_new"|"generic", suggestions } из
   исходного вопроса, на который сейчас пришёл ответ (см. aiq:<msgId> в bot.js). */
async function runAutoWork(num, extraContext, aiqInfo) {
  const settings = { ...DEFAULT_SETTINGS, ...((await redis.get("ai:settings")) || {}) };
  if (!settings.autoWork) return { ok: true, skipped: "autoWork disabled" };
  if (!process.env.OPENAI_API_KEY) return { ok: true, skipped: "no OPENAI_API_KEY" };

  const task = await redis.get("task:" + num);
  if (!task) return { ok: false, error: "task not found" };
  if (task.status === "done" || task.status === "cancelled") return { ok: true, skipped: "task closed" };

  /* Ответ на уточнение именно по контрагенту — не пере-спрашиваем ИИ весь черновик
     заново вслепую, а сначала пытаемся умно интерпретировать сам ответ:
     1) совпадает с одним из предложенных вариантов → используем его Ref_Key напрямую;
     2) явное "новый контрагент"/"да" (если вопрос был confirm_new) → создаём карточку;
     3) иначе — это уточнённое название/ИНН, пробуем резолвить его ещё раз по-настоящему
        (через ИНН/точное имя в 1С), не создавая ничего вслепую; ограничиваем число
        повторных уточнений, чтобы не зациклиться на одном и том же вопросе. */
  if (extraContext && aiqInfo && (aiqInfo.kind === "counterparty" || aiqInfo.kind === "confirm_new") && task.aiDraft) {
    const draft = task.aiDraft;
    const trimmed = String(extraContext).trim();
    const normReply = normCompanyLocal(trimmed);

    let matched = null;
    for (const s of (aiqInfo.suggestions || [])) {
      const score = fuzzyScoreLocal(normReply, normCompanyLocal(s.name || ""));
      if (score >= 0.5 && (!matched || score > matched.score)) matched = { ...s, score };
    }

    if (matched) {
      const execRes = await internal1cPost({ action: "execute_task", num, counterpartyRef: matched.ref });
      if (execRes.ok) return await reportExecSuccess(num, task, draft, execRes);
      if (execRes.counterpartyAmbiguous) return await askClarificationInGroup(num, task, execRes.error, execRes.noMatch ? "confirm_new" : "counterparty", execRes.suggestions || []);
      return await reportExecBlocked(num, task, execRes.error);
    }

    const wantsNew = NEW_COUNTERPARTY_RE.test(trimmed) || (aiqInfo.kind === "confirm_new" && CONFIRM_YES_RE.test(trimmed));
    if (wantsNew) {
      const execRes = await internal1cPost({ action: "execute_task", num, confirmNewCounterparty: true });
      if (execRes.ok) return await reportExecSuccess(num, task, draft, execRes);
      return await reportExecBlocked(num, task, execRes.error);
    }

    /* похоже на уточнённое название или ИНН — обновляем черновик и пробуем резолвить
       ещё раз по-настоящему (без force и без confirm), ограничивая число попыток */
    const rounds = Number(task.aiClarifyRounds || 0);
    const cleanedForInn = trimmed.replace(/\s+/g, "");
    task.aiDraft = {
      ...draft,
      counterparty: INN_ONLY_RE.test(cleanedForInn) ? draft.counterparty : trimmed,
      ...(INN_ONLY_RE.test(cleanedForInn) ? { counterpartyInn: cleanedForInn } : {}),
    };
    await redis.set("task:" + num, task);

    if (rounds >= 2) {
      /* два уточнения подряд ни к чему не привели — не зацикливаемся дальше,
         создаём документ без привязки контрагента и прозрачно об этом сообщаем */
      const execRes = await internal1cPost({ action: "execute_task", num, force: true });
      if (execRes.ok) {
        return await reportExecSuccess(num, task, task.aiDraft, {
          ...execRes,
          note: `Контрагент так и не был однозначно опознан после ${rounds + 1} уточнений — документ создан БЕЗ привязки контрагента, заполните её вручную в 1С.`,
        });
      }
      return await reportExecBlocked(num, task, execRes.error);
    }

    task.aiClarifyRounds = rounds + 1;
    await redis.set("task:" + num, task);
    const execRes = await internal1cPost({ action: "execute_task", num });
    if (execRes.ok) return await reportExecSuccess(num, task, task.aiDraft, execRes);
    if (execRes.counterpartyAmbiguous) return await askClarificationInGroup(num, task, execRes.error, execRes.noMatch ? "confirm_new" : "counterparty", execRes.suggestions || []);
    if (execRes.duplicate) return await askClarificationInGroup(num, task, execRes.error, "duplicate", []);
    return await reportExecBlocked(num, task, execRes.error);
  }

  /* Ответ на уточнение по СОТРУДНИКУ (кадровые документы) — сотрудника
     никогда не создаём автоматически (в отличие от контрагента), поэтому
     здесь только два исхода: совпадение с предложенным вариантом, либо
     уточнённое ФИО, которое пробуем резолвить ещё раз по-настоящему. */
  if (extraContext && aiqInfo && aiqInfo.kind === "employee" && task.aiDraft) {
    const draft = task.aiDraft;
    const trimmed = String(extraContext).trim();
    const normReply = normCompanyLocal(trimmed);

    let matched = null;
    for (const s of (aiqInfo.suggestions || [])) {
      const score = fuzzyScoreLocal(normReply, normCompanyLocal(s.name || ""));
      if (score >= 0.5 && (!matched || score > matched.score)) matched = { ...s, score };
    }

    if (matched) {
      const execRes = await internal1cPost({ action: "execute_task", num, employeeRef: matched.ref });
      if (execRes.ok) return await reportExecSuccess(num, task, draft, execRes);
      if (execRes.employeeAmbiguous) return await askClarificationInGroup(num, task, execRes.error, "employee", execRes.suggestions || []);
      return await reportExecBlocked(num, task, execRes.error);
    }

    const rounds = Number(task.aiClarifyRounds || 0);
    task.aiDraft = { ...draft, employee: trimmed };
    await redis.set("task:" + num, task);

    if (rounds >= 2) {
      /* сотрудника так и не опознали за 2 уточнения — карточку не создаём
         (в отличие от контрагента), просто честно сообщаем, что нужна ручная обработка */
      return await reportExecBlocked(num, task, `Сотрудник так и не был однозначно опознан после ${rounds + 1} уточнений. Кадровый документ требует точного совпадения — обработайте задачу вручную.`);
    }

    task.aiClarifyRounds = rounds + 1;
    await redis.set("task:" + num, task);
    const execRes = await internal1cPost({ action: "execute_task", num });
    if (execRes.ok) return await reportExecSuccess(num, task, task.aiDraft, execRes);
    if (execRes.employeeAmbiguous) return await askClarificationInGroup(num, task, execRes.error, "employee", execRes.suggestions || []);
    if (execRes.duplicate) return await askClarificationInGroup(num, task, execRes.error, "duplicate", []);
    return await reportExecBlocked(num, task, execRes.error);
  }

  /* Подтверждение на вопрос про возможный дубль документа — это простое да/нет,
     не про контрагента и не повод пере-спрашивать ИИ весь черновик заново. */
  if (extraContext && aiqInfo && aiqInfo.kind === "duplicate" && task.aiDraft) {
    const confirms = CONFIRM_YES_RE.test(String(extraContext).trim()) || /отдельн|разн|повтор|ещ[её] раз|продолж/i.test(extraContext);
    if (confirms) {
      const execRes = await internal1cPost({ action: "execute_task", num, force: true });
      if (execRes.ok) return await reportExecSuccess(num, task, task.aiDraft, execRes);
      if (execRes.counterpartyAmbiguous) return await askClarificationInGroup(num, task, execRes.error, execRes.noMatch ? "confirm_new" : "counterparty", execRes.suggestions || []);
      return await reportExecBlocked(num, task, execRes.error);
    }
    return await reportExecBlocked(num, task, `Похоже на повтор документа — по ответу бухгалтера решено НЕ создавать документ повторно. Если нужно всё-таки создать — откройте задачу и повторите вручную.`);
  }

  let clientInfo = null;
  try {
    const cid = await redis.get("clientcompany:" + normCompanyLocal(task.company));
    if (cid) clientInfo = await redis.get("client:" + cid);
  } catch (e) { /* noop */ }

  const taskForDraft = extraContext
    ? { ...task, text: `${task.text}

Уточнение бухгалтера (в ответ на вопрос ИИ): ${extraContext}` }
    : task;

  let draft;
  try { draft = await draftFromTask(taskForDraft, clientInfo); } catch (e) { draft = null; }
  if (!draft) {
    await logEvent("ai_autowork_draft_failed", { num });
    return { ok: false, error: "не удалось подготовить черновик" };
  }
  task.aiDraft = { ...draft, generatedAt: new Date().toISOString(), by: "AI-бухгалтер (авто)" };
  task.aiClarifyRounds = 0;
  await redis.set("task:" + num, task);

  await internalCrmPost({ action: "status", num, status: "in_progress", assignee: "AI-бухгалтер" });

  const lowConfidence = draft.confidence != null && Number(draft.confidence) < 0.5;
  const missingAmount = AUTOWORK_MONEY_TYPES.has(draft.type) && !draft.amount;
  if (draft.type === "other" || lowConfidence || missingAmount) {
    const q = draft.notes || `Не до конца понял заявку по задаче №${num} (тип: ${draft.type}, сумма: ${draft.amount ?? "не указана"}). Что нужно сделать?`;
    return await askClarificationInGroup(num, task, q, "draft_unclear", []);
  }

  const execRes = await internal1cPost({ action: "execute_task", num });

  if (execRes.ok) return await reportExecSuccess(num, task, draft, execRes);

  if (execRes.counterpartyAmbiguous) {
    return await askClarificationInGroup(num, task, execRes.error, execRes.noMatch ? "confirm_new" : "counterparty", execRes.suggestions || []);
  }
  if (execRes.employeeAmbiguous) {
    return await askClarificationInGroup(num, task, execRes.error, "employee", execRes.suggestions || []);
  }
  if (execRes.duplicate) {
    return await askClarificationInGroup(num, task, execRes.error, "duplicate", []);
  }

  return await reportExecBlocked(num, task, execRes.error);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-api-key,authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  /* staff-гейт как в crm.js */
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

  try {
    const q = req.query || {};
    const hasKey = !!process.env.OPENAI_API_KEY;

    if (req.method === "GET") {
      if (q.r === "ping") {
        const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
        if (!hasKey) return res.status(200).json({ ok: false, key: false, model, error: "OPENAI_API_KEY не задан в Vercel" });
        if (q.test) {
          try {
            const r = await chat([{ role: "user", content: 'Ответь JSON {"pong": true}' }], { maxTokens: 20, timeoutMs: 10000 });
            return res.status(200).json({ ok: !!r.pong, key: true, model, live: true });
          } catch (e) {
            return res.status(200).json({ ok: false, key: true, model, error: String(e).slice(0, 200) });
          }
        }
        return res.status(200).json({ ok: true, key: true, model });
      }
      if (q.r === "chats") {
        return res.status(200).json({ ok: true, chats: await listChats() });
      }
      if (q.r === "chat" && q.id) {
        const msgs = (await redis.get("aichat:msgs:" + q.id)) || [];
        return res.status(200).json({ ok: true, messages: msgs });
      }
      if (q.r === "usage") {
        return res.status(200).json({ ok: true, usage: await getUsage(redis, Number(q.days) || 7) });
      }
      if (q.r === "settings") {
        const cur = (await redis.get("ai:settings")) || {};
        return res.status(200).json({ ok: true, settings: { ...DEFAULT_SETTINGS, ...cur }, key: hasKey });
      }
      return res.status(200).json({ ok: true, service: "Finpulse AI", routes: ["ping", "settings"] });
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
      const actor = (authUser && authUser.name) || "CRM";

      if (body && body.action === "agent" && Array.isArray(body.messages)) {
        const isAdmin = !JWT_SECRET || (authUser && authUser.role === "admin");
        if (!isAdmin) return res.status(403).json({ ok: false, error: "только супер-админ" });
        const out = await runAgent(body.messages, {
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
          ...(req.headers["x-api-key"] ? { "x-api-key": req.headers["x-api-key"] } : {}),
        });
        let chatId = body.chatId || null;
        try { chatId = await persistChat(body.chatId, body.messages, out.reply, out.steps); } catch (e) { /* noop */ }
        await logEvent("ai_agent_run", { steps: out.steps.length, by: actor });
        return res.status(200).json({ ok: true, chatId, ...out });
      }
      if (body && body.action === "chat_delete" && body.id) {
        const isAdmin = !JWT_SECRET || (authUser && authUser.role === "admin");
        if (!isAdmin) return res.status(403).json({ ok: false, error: "только супер-админ" });
        const all = await listChats();
        await redis.del("aichat:threads");
        const rest = all.filter((c) => c.id !== body.id);
        if (rest.length) await redis.rpush("aichat:threads", ...rest.map((c) => JSON.stringify(c)));
        await redis.del("aichat:msgs:" + body.id);
        return res.status(200).json({ ok: true });
      }
      if (body && body.action === "chat_clear_all") {
        const isAdmin = !JWT_SECRET || (authUser && authUser.role === "admin");
        if (!isAdmin) return res.status(403).json({ ok: false, error: "только супер-админ" });
        const all = await listChats();
        for (const c of all) { try { await redis.del("aichat:msgs:" + c.id); } catch (e) { /* noop */ } }
        await redis.del("aichat:threads");
        await logEvent("ai_chats_cleared", { count: all.length, by: actor });
        return res.status(200).json({ ok: true, cleared: all.length });
      }
      if (body && body.action === "settings_save" && body.settings) {
        const clean = {
          classify: body.settings.classify !== false,
          drafts: body.settings.drafts !== false,
          summarize: body.settings.summarize !== false,
          autoWork: body.settings.autoWork === true,
        };
        await redis.set("ai:settings", clean);
        await logEvent("ai_settings_updated", { ...clean, by: actor });
        return res.status(200).json({ ok: true, settings: clean });
      }

      if (!hasKey) return res.status(200).json({ ok: false, error: "OPENAI_API_KEY не задан" });

      if (body && body.action === "classify" && body.text) {
        const saved = (await redis.get("bot:categories")) || [];
        const cats = Array.isArray(saved) && saved.length ? saved : DEFAULT_CATEGORIES;
        const r = await classifyTask(String(body.text), cats, { redis });
        return res.status(200).json({ ok: true, result: r });
      }

      if (body && body.action === "draft" && body.num) {
        const task = await redis.get("task:" + Number(body.num));
        if (!task) return res.status(200).json({ ok: false, error: "task not found" });
        let clientInfo = null;
        try {
          const cid = await redis.get("clientcompany:" + String(task.company || "").toLowerCase().replace(/[^a-zа-яё0-9]+/gi, " ").trim());
          if (cid) clientInfo = await redis.get("client:" + cid);
        } catch (e) { /* noop */ }
        const draft = await draftFromTask(task, clientInfo);
        if (!draft) return res.status(200).json({ ok: false, error: "ИИ не смог подготовить черновик" });
        task.aiDraft = { ...draft, generatedAt: new Date().toISOString(), by: actor };
        await redis.set("task:" + Number(body.num), task);
        await logEvent("ai_draft_created", { num: task.num, type: draft.type, by: actor });
        return res.status(200).json({ ok: true, draft: task.aiDraft });
      }

      if (body && body.action === "auto_work" && body.num) {
        const r = await runAutoWork(Number(body.num), body.extraContext || null, body.aiqInfo || null);
        return res.status(200).json(r);
      }

      if (body && body.action === "summarize" && body.num) {
        const task = await redis.get("task:" + Number(body.num));
        if (!task) return res.status(200).json({ ok: false, error: "task not found" });
        const summary = await summarizeThread(task);
        if (!summary) return res.status(200).json({ ok: false, error: "нечего суммировать" });
        task.aiSummary = { text: summary, at: new Date().toISOString() };
        await redis.set("task:" + Number(body.num), task);
        return res.status(200).json({ ok: true, summary });
      }

      return res.status(200).json({ ok: false, error: "unknown action" });
    }

    res.status(405).json({ ok: false });
  } catch (e) {
    console.error("ai api:", e);
    res.status(200).json({ ok: false, error: String(e).slice(0, 300) });
  }
};
