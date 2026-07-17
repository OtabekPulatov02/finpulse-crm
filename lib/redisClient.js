/* Общий Redis-клиент с опциональным префиксом ключей.
   Задача: изоляция стейджинг-окружения от прод-данных БЕЗ отдельной
   Upstash-базы (провижининг новой базы через Vercel Marketplace требует
   привязки банковской карты — решили не делать это автоматически).
   Вместо этого стейджинг-бэкенд использует ТОТ ЖЕ Redis, что и прод, но
   все ключи получают префикс REDIS_KEY_PREFIX (например "staging:"),
   так что данные логически не пересекаются с прод-ключами. */
const { Redis } = require("@upstash/redis");

const PREFIX = process.env.REDIS_KEY_PREFIX || "";

const raw = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

function pk(key) {
  return PREFIX && typeof key === "string" ? PREFIX + key : key;
}

function stripPrefix(key) {
  if (!PREFIX || typeof key !== "string") return key;
  return key.startsWith(PREFIX) ? key.slice(PREFIX.length) : key;
}

const SINGLE_KEY_PASSTHROUGH = [
  "get",
  "set",
  "incr",
  "incrby",
  "incrbyfloat",
  "lpush",
  "lrange",
  "lset",
  "ltrim",
  "rpush",
  "sadd",
  "smembers",
  "srem",
  "expire",
];

const redis = {};

for (const method of SINGLE_KEY_PASSTHROUGH) {
  redis[method] = (key, ...rest) => raw[method](pk(key), ...rest);
}

redis.mget = (...keys) => raw.mget(...keys.map(pk));
redis.del = (...keys) => raw.del(...keys.map(pk));

redis.scan = async (cursor, opts = {}) => {
  const o = { ...opts };
  if (o.match) o.match = pk(o.match);
  const res = await raw.scan(cursor, o);
  const [next, keys] = res;
  return [next, PREFIX ? keys.map(stripPrefix) : keys];
};

module.exports = redis;
module.exports.raw = raw;
module.exports.PREFIX = PREFIX;
