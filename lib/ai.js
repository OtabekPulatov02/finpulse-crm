/* ============================================================
   Finpulse CRM — общий ИИ-клиент (OpenAI Chat Completions).

   Ключ: OPENAI_API_KEY (Vercel env). Модель: OPENAI_MODEL
   (по умолчанию gpt-4o-mini — быстрая и дешёвая для черновиков).

   Принцип: ИИ только классифицирует и готовит ЧЕРНОВИКИ —
   ничего не проводит и не отправляет сам.
   ============================================================ */

const KEY = () => process.env.OPENAI_API_KEY || "";
const MODEL = () => process.env.OPENAI_MODEL || "gpt-4o-mini";

async function chat(messages, { maxTokens = 500, timeoutMs = 12000 } = {}) {
  if (!KEY()) throw new Error("OPENAI_API_KEY is not set");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY()}` },
    body: JSON.stringify({
      model: MODEL(),
      messages,
      max_tokens: maxTokens,
      temperature: 0.1,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(content); } catch { return {}; }
}

/* Классификация заявки клиента по категориям услуг из справочника CRM */
async function classifyTask(text, categories) {
  const catList = categories.map((c) => ({
    name: String(c.name).replace(/^[^\wа-яА-ЯёЁ]+\s*/, ""),
    subs: c.subs || [],
  }));
  const res = await chat([
    { role: "system", content: "Ты — ассистент бухгалтерской компании в Узбекистане. Классифицируй заявку клиента. Отвечай строго JSON: {\"category\": \"название из списка или null\", \"sub\": \"подкатегория из списка или null\", \"confidence\": 0..1}. Если не уверен (confidence < 0.6) — верни category: null." },
    { role: "user", content: `Категории: ${JSON.stringify(catList)}\n\nЗаявка клиента: «${String(text).slice(0, 1500)}»` },
  ], { maxTokens: 150 });
  if (!res || !res.category || (res.confidence != null && res.confidence < 0.6)) return null;
  const match = catList.find((c) => c.name.toLowerCase() === String(res.category).toLowerCase());
  if (!match) return null;
  const sub = res.sub && match.subs.find((s) => s.toLowerCase() === String(res.sub).toLowerCase());
  return { category: match.name, sub: sub || null };
}

/* Черновик операции из текста заявки: структура для будущего документа 1С.
   Бухгалтер видит черновик в CRM, правит и сам проводит через Didox. */
async function draftFromTask(task, clientInfo) {
  const res = await chat([
    { role: "system", content: `Ты — помощник бухгалтера (Узбекистан, суммы в UZS). Из заявки клиента подготовь ЧЕРНОВИК операции строго в JSON:
{
 "type": "payment | invoice_esf | act_sverki | contract | hr | report | other",
 "title": "короткое название операции",
 "counterparty": "контрагент или null",
 "amount": число в сумах или null,
 "purpose": "назначение платежа/суть операции",
 "dueDate": "YYYY-MM-DD или null",
 "notes": "что бухгалтеру нужно уточнить у клиента, или null",
 "confidence": 0..1
}
Не выдумывай реквизиты. Если данных мало — заполни notes.` },
    { role: "user", content: `Компания клиента: ${clientInfo?.company || task.company || "?"}\nКатегория: ${task.category || "не указана"}${task.sub ? " / " + task.sub : ""}\n\nЗаявка: «${String(task.text).slice(0, 2000)}»` },
  ], { maxTokens: 400 });
  if (!res || !res.type) return null;
  return res;
}

/* Короткая выжимка длинной переписки по задаче */
async function summarizeThread(task) {
  const thread = (task.thread || []).map((m) => `${m.from === "client" ? "Клиент" : "Бухгалтер"}: ${m.text || "[файл]"}`).join("\n").slice(0, 4000);
  const res = await chat([
    { role: "system", content: "Суммируй переписку по бухгалтерской задаче в 2-3 предложениях на русском. JSON: {\"summary\": \"...\"}" },
    { role: "user", content: `Задача: ${task.text?.slice(0, 300)}\n\nПереписка:\n${thread}` },
  ], { maxTokens: 200 });
  return res?.summary || null;
}

module.exports = { chat, classifyTask, draftFromTask, summarizeThread };
