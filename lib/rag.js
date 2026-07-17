/* RAG-база знаний (задача #11 из бэклога): проверенные ответы бухгалтеров
   и регламенты Finpulse — ИИ ищет по ним перед тем, как отвечать из общих
   знаний, и явно цитирует найденное, а не выдаёт общий текст про 1С/налоги
   УЗ, где легко ошибиться в деталях. Векторный поиск через embeddings
   OpenAI (text-embedding-3-small) + косинусное сходство на лету — датасет
   у одной бухгалтерской компании небольшой (десятки-сотни записей), полный
   перебор в памяти на каждый запрос быстрее и проще, чем поднимать
   отдельную векторную БД. */
const KEY = () => process.env.OPENAI_API_KEY || "";
const DOC_IDS_KEY = "rag:docs";
const docKey = (id) => "rag:doc:" + id;

async function embed(text) {
  if (!KEY()) throw new Error("OPENAI_API_KEY is not set");
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY()}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 8000) }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error("embeddings HTTP " + r.status + ": " + (await r.text()).slice(0, 200));
  const data = await r.json();
  return data.data?.[0]?.embedding || null;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function listDocIds(redis) {
  return (await redis.smembers(DOC_IDS_KEY)) || [];
}

/* Список без эмбеддингов — для отображения в CRM (эмбеддинг тяжёлый и не нужен UI). */
async function listDocs(redis) {
  const ids = await listDocIds(redis);
  if (!ids.length) return [];
  const rows = await redis.mget(...ids.map(docKey));
  return rows.filter(Boolean).map((d) => ({ id: d.id, title: d.title, content: d.content, tags: d.tags || [], createdAt: d.createdAt, by: d.by }))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

async function addDoc(redis, { title, content, tags, by }) {
  const text = `${title}\n${content}`.trim();
  if (!text) throw new Error("title/content required");
  const embedding = await embed(text);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const doc = {
    id, title: String(title || "").slice(0, 200), content: String(content || "").slice(0, 6000),
    tags: Array.isArray(tags) ? tags.slice(0, 10).map(String) : [],
    embedding, createdAt: new Date().toISOString(), by: by || "CRM",
  };
  await redis.set(docKey(id), doc);
  await redis.sadd(DOC_IDS_KEY, id);
  return { id, title: doc.title, content: doc.content, tags: doc.tags, createdAt: doc.createdAt, by: doc.by };
}

async function deleteDoc(redis, id) {
  await redis.del(docKey(id));
  await redis.srem(DOC_IDS_KEY, id);
  return { ok: true };
}

/* Поиск: эмбеддим запрос, считаем косинусное сходство со всеми документами,
   возвращаем top-K выше порога релевантности (0.75 — эмпирически разумный
   порог для text-embedding-3-small, чтобы не подсовывать явно нерелевантное). */
async function search(redis, query, topK) {
  const k = topK || 3;
  if (!query || !query.trim()) return [];
  const ids = await listDocIds(redis);
  if (!ids.length) return [];
  const qVec = await embed(query);
  if (!qVec) return [];
  const rows = (await redis.mget(...ids.map(docKey))).filter((d) => d && Array.isArray(d.embedding));
  const scored = rows
    .map((d) => ({ id: d.id, title: d.title, content: d.content, tags: d.tags || [], score: cosine(qVec, d.embedding) }))
    .filter((d) => d.score >= 0.6)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return scored;
}

module.exports = { addDoc, deleteDoc, listDocs, search, embed, cosine };
