/* ============================================================
   Finpulse CRM — экспорт снапшота Redis для ежедневного бэкапа.

   Зачем: вся живая база — один Upstash Redis без снапшотов.
   Если аккаунт удалят/заблокируют или произойдёт ошибка записи —
   восстановить данные неоткуда. Этот модуль собирает JSON-снимок
   всех "живых" данных (задачи, клиенты, сотрудники, календарь,
   справочники, память AI, тарифы, настройки) через SCAN по
   известным префиксам ключей — без хардкода конкретных ID.

   Хранение снапшота — вне зоны ответственности этого файла (см.
   api/cron/backup.js, который пушит результат в GitHub).
   ============================================================ */

const KEY_PATTERNS = [
  "task:*",
  "client:*",
  "employee:*",
  "calendarevent:*",
  "dicts:custom",
  "tariffs",
  "assign:rules",
  "notif:settings",
  "bot:settings",
  "bot:categories",
  "bot:positions",
  "group",
  "1c:apps",
  "1c:orgmap",
  "1c:cpmap",
  "1c:ctmap",
  "1c:nommap",
  "ai:memory:*",
  "ai:autowork",
  "ai:usage:*",
  "rag:doc:*",
  "rag:docs",
  "nps:*",
  "askconvo:*",
];

async function scanAll(redis, pattern) {
  const keys = [];
  let cursor = "0";
  do {
    const res = await redis.scan(cursor, { match: pattern, count: 200 });
    const next = Array.isArray(res) ? res[0] : res.cursor;
    const batch = Array.isArray(res) ? res[1] : res.keys;
    cursor = String(next);
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

async function exportSnapshot(redis) {
  const data = {};
  const skipped = [];
  let totalKeys = 0;

  for (const pattern of KEY_PATTERNS) {
    const keys = await scanAll(redis, pattern);
    for (const key of keys) {
      totalKeys++;
      try {
        const val = await redis.get(key);
        if (val !== null && val !== undefined) {
          data[key] = val;
          continue;
        }
        try {
          const asList = await redis.lrange(key, 0, -1);
          if (Array.isArray(asList) && asList.length) { data[key] = { __type: "list", items: asList }; continue; }
        } catch (e) { /* not a list */ }
        try {
          const asSet = await redis.smembers(key);
          if (Array.isArray(asSet) && asSet.length) { data[key] = { __type: "set", items: asSet }; continue; }
        } catch (e) { /* not a set */ }
        skipped.push(key);
      } catch (e) {
        skipped.push(key);
      }
    }
  }

  return {
    meta: {
      exportedAt: new Date().toISOString(),
      totalKeys,
      savedKeys: Object.keys(data).length,
      skippedKeys: skipped,
      patterns: KEY_PATTERNS,
    },
    data,
  };
}

module.exports = { exportSnapshot, scanAll, KEY_PATTERNS };
