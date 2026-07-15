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
onec_get: r=apps | r=ping | r=meta&app=<code> | r=orgs&app=<code>
onec_post: {action:"sync_orgs", app} | {action:"execute_task", num} — создаёт НЕПРОВЕДЁННЫЙ документ в 1С базе клиента из AI-черновика задачи (главная операция!) | {action:"create_draft", app, entity, fields}
Пайплайн выполнения задачи клиента в 1С: 1) crm_get r=tasks — найди задачу; 2) ai_draft {num} — подготовь черновик операции; 3) onec_post {action:"execute_task", num} — создай непроведённый документ в 1С базе клиента; 4) crm_post {action:"status", num, status:"in_progress", assignee:"AI-бухгалтер"} и сообщи, что бухгалтеру осталось проверить и провести.

Правила:
1. Всегда сначала читай данные (crm_get), потом действуй.
2. Деструктивные действия (delete, сброс пароля, массовые изменения) — только после явного подтверждения в диалоге. Если его нет — опиши, что собираешься сделать, и спроси.
3. Отвечай кратко, по-русски, с итогом что сделано. Числа/суммы — как в данных.
4. Если данных нет или API вернул ошибку — скажи честно.`;

const AGENT_TOOLS = [
  { type: "function", function: { name: "crm_get", description: "GET-запрос к /api/crm. Аргумент query — строка после ?, напр. \"r=tasks\"", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "crm_post", description: "POST к /api/crm. body — объект действия, напр. {\"action\":\"status\",\"num\":106,\"status\":\"done\"}", parameters: { type: "object", properties: { body: { type: "object" } }, required: ["body"] } } },
  { type: "function", function: { name: "onec_get", description: "GET к /api/1c (интеграция 1С). query напр. \"r=ping\"", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "onec_post", description: "POST к /api/1c, напр. {\"action\":\"sync_orgs\",\"app\":\"46516\"}", parameters: { type: "object", properties: { body: { type: "object" } }, required: ["body"] } } },
  { type: "function", function: { name: "ai_draft", description: "Сгенерировать AI-черновик операции для задачи CRM (сохраняется в task.aiDraft). Аргумент num — номер задачи.", parameters: { type: "object", properties: { num: { type: "number" } }, required: ["num"] } } },
  { type: "function", function: { name: "memory_get", description: "Долгосрочная память по компании клиента (факты).", parameters: { type: "object", properties: { company: { type: "string" } }, required: ["company"] } } },
  { type: "function", function: { name: "memory_add", description: "Записать устойчивый факт о компании в память (аренда, банк, договорённости).", parameters: { type: "object", properties: { company: { type: "string" }, fact: { type: "string" } }, required: ["company", "fact"] } } },
];

async function callTool(name, args, authHeader) {
  const base = name.startsWith("crm") ? SELF + "/api/crm" : SELF + "/api/1c";
  try {
    let r;
    if (name.endsWith("_get")) {
      r = await fetch(base + "?" + String(args.query || ""), { headers: { authorization: authHeader }, signal: AbortSignal.timeout(20000) });
    } else {
      r = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: authHeader },
        body: JSON.stringify(args.body || {}),
        signal: AbortSignal.timeout(25000),
      });
    }
    const text = await r.text();
    return text.slice(0, 6000);
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e).slice(0, 200) });
  }
}

async function runAgent(messages, authHeader) {
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
    for (const tc of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch (e) { /* noop */ }
      let result;
      if (tc.function.name === "memory_get") {
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
        result = await callTool(tc.function.name, args, authHeader);
      }
      steps.push({ tool: tc.function.name, args: JSON.stringify(args).slice(0, 200), ok: !result.includes('"ok":false') });
      convo.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }
  return { reply: "Достигнут лимит шагов — уточните задачу или разбейте её на части.", steps };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-api-key,authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  /* staff-гейт как в crm.js */
  let authUser = null;
  const JWT_SECRET = process.env.CRM_JWT_SECRET;
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
        const out = await runAgent(body.messages, req.headers.authorization || "");
        await logEvent("ai_agent_run", { steps: out.steps.length, by: actor });
        return res.status(200).json({ ok: true, ...out });
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
