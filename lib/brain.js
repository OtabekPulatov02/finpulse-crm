/* ============================================================
   Finpulse AI Orchestrator («мозг»).

   Перед КАЖДЫМ обращением к GPT собирает контекст:
   профиль клиента → память по компании → история задач →
   контекст 1С (когда OData откроют) → роль пользователя.
   GPT никогда не отвечает «вслепую».

   Экономия токенов:
   - каждый блок контекста жёстко ограничен по длине;
   - память компании ≤ 15 коротких фактов;
   - история ≤ 5 задач одной строкой;
   - учёт расхода: ai:usage:YYYY-MM-DD (prompt/completion) в Redis.
   ============================================================ */

function normCompany(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[«»"'‘’“”.,:;()\-–—_/\\]/g, " ")
    .replace(/\b(ооо|оао|зао|ао|ип|чп|мчж|хк|ooo|oao|llc|ltd|inc|mchj|xk|xt)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const memKey = (company) => "mem:client:" + normCompany(company);

/* ---------- Память по компании ---------- */
async function getMemory(redis, company) {
  try {
    const m = await redis.get(memKey(company));
    return Array.isArray(m) ? m : [];
  } catch (e) { return []; }
}

async function addMemory(redis, company, fact, by) {
  const clean = String(fact || "").trim().slice(0, 200);
  if (!clean) return false;
  const mem = await getMemory(redis, company);
  if (mem.some((f) => f.fact === clean)) return false; // дубликат
  mem.unshift({ fact: clean, at: new Date().toISOString().slice(0, 10), by: by || "AI" });
  await redis.set(memKey(company), mem.slice(0, 15));
  return true;
}

/* ---------- Контекст клиента для промпта ---------- */
async function buildClientContext(redis, company) {
  const norm = normCompany(company);
  const parts = [];

  /* профиль */
  try {
    const cid = await redis.get("clientcompany:" + norm);
    if (cid) {
      const c = await redis.get("client:" + cid);
      if (c) {
        parts.push(`КЛИЕНТ: ${c.company}` +
          (c.inn ? ` · ИНН ${c.inn}` : "") +
          (c.taxSystem ? ` · режим: ${c.taxSystem}` : "") +
          (c.tariff ? ` · тариф: ${c.tariff}` : "") +
          (c.assignedTo ? ` · ответственный: ${c.assignedTo}` : "") +
          (c.bank ? ` · банк: ${c.bank}` : "") +
          (c.bankAccount ? ` · р/с ${c.bankAccount}` : "") +
          (c.mfo ? ` МФО ${c.mfo}` : ""));
        if (c.note) parts.push(`Заметка бухгалтера: ${String(c.note).slice(0, 200)}`);
      }
    }
  } catch (e) { /* noop */ }

  /* память */
  const mem = await getMemory(redis, company);
  if (mem.length) {
    parts.push("ПАМЯТЬ ПО КОМПАНИИ:\n" + mem.slice(0, 15).map((f) => `- ${f.fact} (${f.at})`).join("\n"));
  }

  /* история задач: последние 5 этой компании */
  try {
    const nMax = Number((await redis.get("counter:task")) || 0);
    const keys = [];
    for (let i = 100 + nMax; i > Math.max(100, 100 + nMax - 80); i--) keys.push("task:" + i);
    const recent = keys.length ? await redis.mget(...keys) : [];
    const mine = recent
      .filter((t) => t && normCompany(t.company || "") === norm)
      .slice(0, 5)
      .map((t) => `№${t.num} [${t.status}] ${String(t.text).slice(0, 70)}`);
    if (mine.length) parts.push("ПОСЛЕДНИЕ ЗАДАЧИ КОМПАНИИ:\n" + mine.join("\n"));
  } catch (e) { /* noop */ }

  /* 1С-контекст (оживёт после включения OData провайдером) */
  try {
    const org = await redis.get("1c:orgmap:" + norm);
    parts.push(org
      ? `1С: организация привязана (база ${org.app}). Детальные данные — после включения OData.`
      : "1С: организация ещё не привязана к базе.");
  } catch (e) { /* noop */ }

  return parts.join("\n\n").slice(0, 2500);
}

/* ---------- Учёт расхода токенов ---------- */
async function logUsage(redis, usage, where) {
  try {
    if (!usage) return;
    const day = new Date().toISOString().slice(0, 10);
    await redis.incrby(`ai:usage:${day}:prompt`, usage.prompt_tokens || 0);
    await redis.incrby(`ai:usage:${day}:completion`, usage.completion_tokens || 0);
    await redis.expire(`ai:usage:${day}:prompt`, 60 * 60 * 24 * 45);
    await redis.expire(`ai:usage:${day}:completion`, 60 * 60 * 24 * 45);
    await redis.incrby(`ai:usage:${day}:calls`, 1);
    await redis.expire(`ai:usage:${day}:calls`, 60 * 60 * 24 * 45);
  } catch (e) { /* noop */ }
}

async function getUsage(redis, days = 7) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10);
    const [p, c, calls] = await Promise.all([
      redis.get(`ai:usage:${day}:prompt`),
      redis.get(`ai:usage:${day}:completion`),
      redis.get(`ai:usage:${day}:calls`),
    ]);
    if (p || c || calls) out.push({ day, prompt: Number(p || 0), completion: Number(c || 0), calls: Number(calls || 0) });
  }
  return out;
}

module.exports = { buildClientContext, getMemory, addMemory, logUsage, getUsage, normCompany };
