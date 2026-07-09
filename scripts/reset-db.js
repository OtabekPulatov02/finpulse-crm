#!/usr/bin/env node
/* ============================================================
   Finpulse CRM — очистка Upstash Redis (ручной скрипт, не часть API).

   Запуск (dry-run по умолчанию — ничего не удаляет, только считает):
     node scripts/reset-db.js --tasks --users --logs --pending --routes

   Чтобы реально удалить — добавьте --yes:
     node scripts/reset-db.js --tasks --users --logs --pending --routes --yes

   Категории:
     --tasks      task:*, tasks:withdue, counter:task
     --users      user:*, utasks:*
     --logs       logs:*
     --pending    pending_clients
     --routes     route:g:*, route:c:*  (карточка ↔ сообщение клиенту)
     --clients    client:*, clients, clientcompany:*, clientphone:*, authphone:*
     --employees  employee:*, employees, authlogin:*  (⚠️ удалит и супер-админа!)
     --misc       bizgreet:*  (троттлинг автоответчика, сам истекает по TTL)
     --all        то же, что --tasks --users --logs --pending --routes --misc
                  (НЕ включает --clients/--employees — это отдельный,
                  более осознанный выбор, т.к. там живут реальные клиенты
                  и учётные записи сотрудников/админа)

   Всегда сохраняется ключ "group" (id группы бухгалтеров в Telegram) —
   это настройка интеграции, а не данные для очистки.

   Требует переменные окружения UPSTASH_REDIS_REST_URL / _TOKEN
   (или KV_REST_API_URL / _TOKEN) — те же, что использует сам бэкенд.
   ============================================================ */

const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const CATEGORIES = {
  tasks: { patterns: ["task:*"], exact: ["tasks:withdue", "counter:task"] },
  users: { patterns: ["user:*", "utasks:*"], exact: [] },
  logs: { patterns: ["logs:*"], exact: [] },
  pending: { patterns: [], exact: ["pending_clients"] },
  routes: { patterns: ["route:g:*", "route:c:*"], exact: [] },
  clients: { patterns: ["client:*", "clientcompany:*", "clientphone:*", "authphone:*"], exact: ["clients"] },
  employees: { patterns: ["employee:*", "authlogin:*"], exact: ["employees"] },
  misc: { patterns: ["bizgreet:*"], exact: [] },
};

const ALL_DEFAULT = ["tasks", "users", "logs", "pending", "routes", "misc"];
const PROTECTED_KEYS = new Set(["group"]);

async function collectKeys(categoryNames) {
  const found = new Map(); // key -> category
  for (const name of categoryNames) {
    const cat = CATEGORIES[name];
    if (!cat) continue;
    for (const pattern of cat.patterns) {
      const keys = await redis.keys(pattern);
      for (const k of keys) {
        if (PROTECTED_KEYS.has(k)) continue;
        found.set(k, name);
      }
    }
    for (const k of cat.exact) {
      if (PROTECTED_KEYS.has(k)) continue;
      const exists = await redis.get(k);
      if (exists !== null && exists !== undefined) found.set(k, name);
    }
  }
  return found;
}

async function main() {
  const args = process.argv.slice(2);
  const yes = args.includes("--yes");
  const all = args.includes("--all");

  let selected = Object.keys(CATEGORIES).filter((name) => args.includes("--" + name));
  if (all) selected = Array.from(new Set([...selected, ...ALL_DEFAULT]));

  if (!selected.length) {
    console.log("Не выбрано ни одной категории. Пример:");
    console.log("  node scripts/reset-db.js --tasks --users --logs --pending --routes");
    console.log("  node scripts/reset-db.js --all");
    console.log("\nДоступные категории: " + Object.keys(CATEGORIES).join(", "));
    process.exit(1);
  }

  console.log("Категории для очистки: " + selected.join(", "));
  if (selected.includes("employees")) {
    console.log("⚠️  --employees удалит ВСЕХ сотрудников, включая супер-админа.");
    console.log("   После этого понадобится заново вызвать POST /api/auth {action:\"bootstrap_admin\"}.");
  }

  const found = await collectKeys(selected);
  const byCategory = {};
  for (const [key, cat] of found) {
    (byCategory[cat] ||= []).push(key);
  }

  console.log("\nНайдено ключей: " + found.size);
  for (const [cat, keys] of Object.entries(byCategory)) {
    console.log(`  ${cat}: ${keys.length}`);
  }

  if (!found.size) {
    console.log("\nУдалять нечего.");
    return;
  }

  if (!yes) {
    console.log("\nЭто пробный запуск (dry-run) — ничего не удалено.");
    console.log("Добавьте --yes к той же команде, чтобы реально удалить эти ключи.");
    return;
  }

  console.log("\nУдаляю...");
  const keys = Array.from(found.keys());
  const BATCH = 200;
  let deleted = 0;
  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    await Promise.all(batch.map((k) => redis.del(k)));
    deleted += batch.length;
  }
  console.log(`Готово: удалено ${deleted} ключей.`);
}

main().catch((e) => {
  console.error("Ошибка:", e);
  process.exit(1);
});
