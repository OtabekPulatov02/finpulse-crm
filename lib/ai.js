/* ============================================================
   Finpulse CRM — «AI-бухгалтер»: общий ИИ-модуль.

   Ключ: OPENAI_API_KEY (Vercel env). Модель: OPENAI_MODEL
   (по умолчанию gpt-4o-mini).

   Роль ИИ в системе — главный бухгалтер-наставник: разбирает
   входящие заявки, готовит черновики, подсказывает бухгалтерам
   и суперадмину. Стандарты — бухгалтерия Республики Узбекистан,
   учёт клиентов ведётся в 1С «Бухгалтерия для Узбекистана 3.0»
   (облако Clobus / 1С:Фреш), ЭСФ и ЭДО — через Didox.

   Принцип безопасности: ИИ только классифицирует, анализирует и
   готовит ЧЕРНОВИКИ — проводит операции живой бухгалтер.
   ============================================================ */

const KEY = () => process.env.OPENAI_API_KEY || "";
const MODEL = () => process.env.OPENAI_MODEL || "gpt-4o-mini";

/* ---------- Базовый контекст: бухгалтерия Узбекистана ---------- */
const { CONSTITUTION, KNOWLEDGE_UZ, decisionBlock } = require("./knowledge.js");
const { logUsage } = require("./brain.js");

/* Единое ядро промптов: конституция + база знаний + правила решений */
const UZ_CONTEXT = CONSTITUTION + "\n\n" + KNOWLEDGE_UZ + "\n\n" + decisionBlock();

async function chat(messages, { maxTokens = 500, timeoutMs = 15000, json = true } = {}) {
  if (!KEY()) throw new Error("OPENAI_API_KEY is not set");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY()}` },
    body: JSON.stringify({
      model: MODEL(),
      messages,
      max_tokens: maxTokens,
      temperature: 0.1,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  if (arguments[1] && arguments[1].redis) { void logUsage(arguments[1].redis, data.usage); }
  const content = data.choices?.[0]?.message?.content || "{}";
  if (!json) return content;
  try { return JSON.parse(content); } catch { return {}; }
}

/* ---------- Быстрая классификация ---------- */
async function classifyTask(text, categories, opts = {}) {
  const catList = categories.map((c) => ({
    name: String(c.name).replace(/^[^\wа-яА-ЯёЁ]+\s*/, ""),
    subs: c.subs || [],
  }));
  const res = await chat([
    { role: "system", content: UZ_CONTEXT + '\n\nЗадача: классифицировать заявку клиента. Ответ строго JSON: {"category": "название из списка или null", "sub": "подкатегория из списка или null", "confidence": 0..1}. Если confidence < 0.6 — category: null.' },
    { role: "user", content: `Категории: ${JSON.stringify(catList)}\n\nЗаявка клиента: «${String(text).slice(0, 1500)}»` },
  ], { maxTokens: 150, redis: opts.redis });
  if (!res || !res.category || (res.confidence != null && res.confidence < 0.6)) return null;
  const match = catList.find((c) => c.name.toLowerCase() === String(res.category).toLowerCase());
  if (!match) return null;
  const sub = res.sub && match.subs.find((s) => s.toLowerCase() === String(res.sub).toLowerCase());
  return { category: match.name, sub: sub || null };
}

/* ---------- Полный разбор входящей заявки («AI-бухгалтер на приёме») ---------- */
async function intakeTask({ text, company, categories, employees, today, context, redis }) {
  const catList = categories.map((c) => ({
    name: String(c.name).replace(/^[^\wа-яА-ЯёЁ]+\s*/, ""),
    subs: c.subs || [],
  }));
  const res = await chat([
    { role: "system", content: UZ_CONTEXT + `

Ты принимаешь новую заявку клиента как главный бухгалтер: разбери её и подготовь решение для команды.
Сегодня: ${today}. Ответ строго JSON:
{
 "category": "из списка или null",
 "sub": "подкатегория из списка или null",
 "priority": "низкий|средний|высокий|критический",
 "dueDate": "YYYY-MM-DD — реалистичный срок с учётом налоговых дедлайнов РУз, или null",
 "complexity": "simple|medium|complex",
 "assignee": "имя из списка сотрудников (меньше активных задач, подходит профиль) или null",
 "relevant": true|false,
 "missing": ["каких документов/данных не хватает"],
 "operation1c": "какой документ 1С потребуется или null",
 "hint": "1-3 предложения бухгалтеру: что сделать первым, что проверить, риски",
 "remember": "новый устойчивый факт о компании для долгосрочной памяти (аренда, банк, привычки) или null",
 "confidence": 0..1
}
Приоритет: требования ГНИ/штрафы/блокировка счёта — критический; налоги и зарплата с близким сроком — высокий.
complexity simple — типовая операция с полными данными (оплата по счёту, выписка, типовой акт).` },
    { role: "user", content: `${context ? context + "\n\n" : ""}Сотрудники и их активные задачи: ${JSON.stringify(employees || [])}
Категории: ${JSON.stringify(catList)}

Заявка от ${company || "?"}: «${String(text).slice(0, 2000)}»` },
  ], { maxTokens: 450, timeoutMs: 18000, redis });
  if (!res || typeof res !== "object") return null;
  const match = res.category ? catList.find((c) => c.name.toLowerCase() === String(res.category).toLowerCase()) : null;
  return {
    category: match ? match.name : null,
    sub: match && res.sub ? (match.subs.find((s) => s.toLowerCase() === String(res.sub).toLowerCase()) || null) : null,
    priority: ["низкий", "средний", "высокий", "критический"].includes(res.priority) ? res.priority : "средний",
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(res.dueDate || "")) ? res.dueDate : null,
    complexity: ["simple", "medium", "complex"].includes(res.complexity) ? res.complexity : "medium",
    assignee: res.assignee || null,
    relevant: res.relevant !== false,
    missing: Array.isArray(res.missing) ? res.missing.map(String).slice(0, 6) : [],
    operation1c: res.operation1c || null,
    hint: res.hint ? String(res.hint).slice(0, 600) : null,
    remember: res.remember ? String(res.remember).slice(0, 200) : null,
    confidence: typeof res.confidence === "number" ? res.confidence : 0.5,
  };
}

/* ---------- Черновик операции/документа 1С из заявки ---------- */
async function draftFromTask(task, clientInfo, opts = {}) {
  const res = await chat([
    { role: "system", content: UZ_CONTEXT + `

Подготовь ЧЕРНОВИК операции для 1С «Бухгалтерия для Узбекистана 3.0». Ответ строго JSON:
{
 "type": "payment_out | payment_in | invoice_esf | act_sverki | schet | postuplenie | realizatsiya | contract | hr_prikaz | doverennost | letter | report | other",
 "doc1c": "точное название документа 1С",
 "title": "короткое название операции",
 "counterparty": "контрагент или null",
 "counterpartyInn": "ИНН контрагента или null",
 "amount": число в сумах или null,
 "vat": "12% | без НДС | null",
 "purpose": "назначение платежа/содержание — готовый текст для документа",
 "dueDate": "YYYY-MM-DD или null",
 "requisites": {"account": "р/с или null", "mfo": "МФО или null", "bank": "банк или null"},
 "checklist": ["шаги бухгалтера по порядку"],
 "notes": "что уточнить у клиента, или null",
 "confidence": 0..1
}
Реквизиты бери только из заявки и карточки клиента — не выдумывай.` },
    { role: "user", content: `Компания клиента: ${clientInfo?.company || task.company || "?"}
Реквизиты клиента: ИНН ${clientInfo?.inn || "?"}, р/с ${clientInfo?.bankAccount || "?"}, МФО ${clientInfo?.mfo || "?"}, банк ${clientInfo?.bank || "?"}, режим: ${clientInfo?.taxSystem || "?"}
Категория: ${task.category || "не указана"}${task.sub ? " / " + task.sub : ""}

Заявка: «${String(task.text).slice(0, 2000)}»` },
  ], { maxTokens: 500, timeoutMs: 18000, redis: opts.redis });
  if (!res || !res.type) return null;
  return res;
}

/* ---------- Выжимка переписки ---------- */
async function summarizeThread(task) {
  const thread = (task.thread || []).map((m) => `${m.from === "client" ? "Клиент" : "Бухгалтер"}: ${m.text || "[файл]"}`).join("\n").slice(0, 4000);
  const res = await chat([
    { role: "system", content: UZ_CONTEXT + '\n\nСуммируй переписку по задаче в 2-3 предложениях: текущее состояние, что ждём, от кого. JSON: {"summary": "..."}' },
    { role: "user", content: `Задача: ${task.text?.slice(0, 300)}\n\nПереписка:\n${thread}` },
  ], { maxTokens: 200 });
  return res?.summary || null;
}

module.exports = { chat, classifyTask, intakeTask, draftFromTask, summarizeThread, UZ_CONTEXT };
