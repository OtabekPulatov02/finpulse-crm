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

const DEFAULT_SETTINGS = { classify: true, drafts: true, summarize: true };

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
onec_get: r=apps | r=ping | r=meta&app=<code> | r=orgs&app=<code> | r=counterparties&app=<code> | r=nomenclature&app=<code> | r=contracts&app=<code> | r=turnover&app=<code>&account=<код счёта, напр. 5110>&from=YYYY-MM-DD&to=YYYY-MM-DD — обороты по счёту за период (дебет/кредит/нетто); БЕЗ разбивки по контрагентам (субконто по контрагентам не публикуется через OData в этой конфигурации 1С)
ВАЖНО: <code> — это числовой код приложения 1С (напр. "46516"), а НЕ название компании. Если знаешь только название компании/клиента — сначала вызови onec_get r=apps, найди в списке нужную запись (по полю name) и возьми её code, только потом используй этот code в app=.
onec_post: {action:"sync_orgs", app} | {action:"sync_counterparties", app} | {action:"sync_nomenclature", app} | {action:"sync_contracts", app} | {action:"execute_task", num, force?:true} — создаёт НЕПРОВЕДЁННЫЙ документ в 1С базе клиента из AI-черновика задачи (главная операция!). Если у черновика указан контрагент, а по нему выполнен синк контрагентов — документ создаётся со ссылкой на реального контрагента. Для документов реализация/поступление/счёт на оплату, если в черновике заполнен items (товары/услуги) и выполнен синк номенклатуры — строки документа создаются со ссылкой на реальную номенклатуру, а не только текстом.
Пайплайн выполнения задачи клиента в 1С: 1) crm_get r=tasks — найди задачу; 2) ai_draft {num} — подготовь черновик операции; 3) onec_post {action:"execute_task", num} — создай непроведённый документ в 1С базе клиента; 4) crm_post {action:"status", num, status:"in_progress", assignee:"AI-бухгалтер"} и сообщи, что бухгалтеру осталось проверить и провести. Если execute_task вернул duplicate:true — значит по этой же компании/типу/сумме уже создан документ за последние 24ч (номер задачи указан в ответе); НЕ вызывай сразу повторно с force — сначала вызови ask_user, спроси у пользователя, это действительно отдельная операция или повтор, и только после явного подтверждения вызови execute_task снова с force:true. Если execute_task вернул counterpartyAmbiguous:true — контрагент из заявки не найден точно в синке 1С, но есть похожие варианты (suggestions); вызови ask_user с этими вариантами как options, и после ответа пользователя либо исправь черновик (ai_draft заново с уточнённым именем), либо вызови execute_task с force:true, если пользователь согласен создать документ без привязки контрагента.
ВАЖНО про 1С: НИКОГДА не вызывай onec_post {action:"create_draft", ...} напрямую и никогда не придумывай/не угадывай имена сущностей 1С (entity) сам — единственный поддерживаемый способ создать документ в 1С это пайплайн execute_task выше, который сам подставляет проверенное имя документа по типу черновика.
Поддерживаемые типы черновиков документов 1С (создание НЕПРОВЕДЁННОГО документа в базе клиента): платёж исходящий/входящий, ЭСФ (счёт-фактура выданный), счёт на оплату, поступление товаров/услуг, реализация товаров/услуг, акт сверки, доверенность, приём на работу, увольнение, отпуск. Все эти типы ПОДДЕРЖИВАЮТСЯ через execute_task.
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
async function persistChat(chatId, messages, reply, steps) {
  const id = chatId || "ch" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const stored = [...messages, { role: "assistant", content: reply, steps: steps || [] }].slice(-60);
  await redis.set("aichat:msgs:" + id, stored);
  const firstUser = stored.find((m) => m.role === "user");
  await saveChatMeta({
    id,
    title: String(firstUser?.content || "Диалог").slice(0, 60),
    updatedAt: new Date().toISOString(),
    count: stored.length,
  });
  return id;
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
      if (body && body.action === "settings_save" && body.settings) {
        const clean = {
          classify: body.settings.classify !== false,
          drafts: body.settings.drafts !== false,
          summarize: body.settings.summarize !== false,
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
