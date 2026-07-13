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

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,authorization");
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
        const cats = (await redis.get("bot:categories")) || [];
        const r = await classifyTask(String(body.text), cats.length ? cats : [{ name: "Другое", subs: [] }]);
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
