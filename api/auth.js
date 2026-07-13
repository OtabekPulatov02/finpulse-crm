/* ============================================================
   Finpulse CRM — авторизация веб-CRM (супер-админ / бухгалтер /
   клиент / гость). Общие ключи Redis с api/bot.js и api/crm.js.

   POST /api/auth {action:"login", identity, password}
        → { ok, token, role, name, company? }
   POST /api/auth {action:"guest"}
        → { ok, token, role:"guest" }
   GET  /api/auth?r=me   (Authorization: Bearer <token>)
        → { ok, role, sub, name?, company? }
   POST /api/auth {action:"bootstrap_admin", login, password, name}
        (требует заголовок x-bootstrap-secret === BOOTSTRAP_ADMIN_SECRET;
         срабатывает только один раз, пока нет ни одного сотрудника)
   ============================================================ */

const { Redis } = require("@upstash/redis");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const JWT_SECRET = process.env.JWT_SECRET || "";
const TOKEN_TTL = "7d";

const API_KEY = process.env.CRM_API_KEY || "";
const ALLOWED_ORIGINS = (process.env.CRM_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/* Слабые/незаданные секреты — предупреждаем в логах Vercel, но не роняем
   функцию (чтобы не сломать прод, если секрет уже короче рекомендуемого
   и это заметят только сейчас). */
if (JWT_SECRET && JWT_SECRET.length < 32) {
  console.warn("SECURITY: JWT_SECRET короче 32 символов — увеличьте длину секрета.");
}
if (process.env.BOOTSTRAP_ADMIN_SECRET && process.env.BOOTSTRAP_ADMIN_SECRET.length < 20) {
  console.warn("SECURITY: BOOTSTRAP_ADMIN_SECRET короче 20 символов — увеличьте длину секрета.");
}

function resolveOrigin(req) {
  const origin = req.headers.origin || "";
  if (!ALLOWED_ORIGINS.length) return origin || "*";
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

/* Сравнение секретов за постоянное время — обычное ===/!== для
   bearer-подобных значений (API-ключ, bootstrap-секрет) теоретически
   позволяет измерять тайминг посимвольного сравнения. timingSafeEqual
   требует буферы одинаковой длины, поэтому сначала выравниваем через
   отдельную проверку длины (сама эта проверка не секрет — длина ключа
   не является чувствительной информацией). */
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  if (bufA.length !== bufB.length) return false;
  try { return crypto.timingSafeEqual(bufA, bufB); } catch { return false; }
}

function checkApiKey(req) {
  if (!API_KEY) return true;
  return timingSafeStringEqual(req.headers["x-api-key"], API_KEY);
}

/* --- Простая защита от подбора пароля: не более MAX_ATTEMPTS неудачных
   попыток логина на один identity за WINDOW_SEC секунд. Считаем именно
   по identity (телефон/логин), а не по IP — в serverless-окружении Vercel
   IP-заголовки (x-forwarded-for) не всегда надёжны/уникальны, а identity
   даёт прямую защиту от подбора пароля к конкретному аккаунту. */
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_WINDOW_SEC = 10 * 60;
async function isLoginLocked(identity) {
  const key = "loginattempts:" + String(identity || "").toLowerCase();
  const n = Number((await redis.get(key)) || 0);
  return n >= LOGIN_MAX_ATTEMPTS;
}
async function registerFailedLogin(identity) {
  const key = "loginattempts:" + String(identity || "").toLowerCase();
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, LOGIN_WINDOW_SEC);
}
async function clearFailedLogins(identity) {
  const key = "loginattempts:" + String(identity || "").toLowerCase();
  await redis.del(key);
}
function normPhone(p) {
  return String(p || "").replace(/[^\d+]/g, "");
}

function sign(payload, ttl) {
  if (!JWT_SECRET) throw new Error("JWT_SECRET is not configured");
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ttl || TOKEN_TTL });
}
function verify(token) {
  if (!JWT_SECRET) return null;
  try { return jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }); } catch { return null; }
}
function getBearer(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

async function findEmployeeByLogin(login) {
  const id = await redis.get("authlogin:" + String(login).toLowerCase());
  if (!id) return null;
  const emp = await redis.get("employee:" + id);
  return emp ? { id, ...emp } : null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", resolveOrigin(req));
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-api-key,x-bootstrap-secret,authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (!checkApiKey(req)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    if (req.method === "GET") {
      const q = req.query || {};
      if (q.r === "me") {
        const token = getBearer(req);
        const payload = token && verify(token);
        if (!payload) return res.status(401).json({ ok: false, error: "invalid session" });
        return res.status(200).json({ ok: true, ...payload });
      }
      return res.status(200).json({ ok: true, service: "Finpulse CRM auth" });
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
      body = body || {};

      if (body.action === "bootstrap_admin") {
        const secret = req.headers["x-bootstrap-secret"];
        if (!process.env.BOOTSTRAP_ADMIN_SECRET || !timingSafeStringEqual(secret, process.env.BOOTSTRAP_ADMIN_SECRET)) {
          return res.status(401).json({ ok: false, error: "unauthorized" });
        }
        const existing = (await redis.smembers("employees")) || [];
        if (existing.length) {
          return res.status(200).json({ ok: false, error: "admin already bootstrapped" });
        }
        const { login, password, name } = body;
        if (!login || !password || !name) {
          return res.status(200).json({ ok: false, error: "login, password, name required" });
        }
        const id = "e" + Date.now().toString(36);
        const emp = { id, name, login: String(login).toLowerCase(), role: "admin", active: true, createdAt: new Date().toISOString() };
        emp.pwdHash = bcrypt.hashSync(password, 10);
        await redis.set("employee:" + id, emp);
        await redis.set("authlogin:" + emp.login, id);
        await redis.sadd("employees", id);
        return res.status(200).json({ ok: true, id });
      }

      if (body.action === "login") {
        const { identity, password } = body;
        if (!identity || !password) {
          return res.status(200).json({ ok: false, error: "identity and password required" });
        }

        /* Защита от подбора пароля: если по этому identity уже было слишком
           много неудачных попыток за последние LOGIN_WINDOW_SEC — не даём
           даже проверить пароль (иначе bcrypt.compareSync всё равно тратит
           время и подтверждает, что аккаунт существует). */
        const lockKey = String(identity).toLowerCase();
        if (await isLoginLocked(lockKey)) {
          return res.status(429).json({ ok: false, error: "too many attempts, try again later" });
        }

        /* 1) Пробуем клиента по телефону */
        const phone = normPhone(identity);
        if (phone) {
          const telegramId = await redis.get("authphone:" + phone);
          if (telegramId) {
            const u = await redis.get("user:" + telegramId);
            if (u && u.pwdHash && bcrypt.compareSync(password, u.pwdHash)) {
              await clearFailedLogins(lockKey);
              const token = sign({ sub: String(telegramId), role: "client", company: u.company, phone });
              return res.status(200).json({ ok: true, token, role: "client", name: u.company });
            }
          }

          /* 2) Пробуем сотрудника по телефону (логин сотрудника, заведённого из CRM) */
          const staffId = await redis.get("staffphone:" + phone);
          if (staffId) {
            const emp = await redis.get("employee:" + staffId);
            if (emp && emp.pwdHash && bcrypt.compareSync(password, emp.pwdHash)) {
              /* Пароль верный, но аккаунт деактивирован админом — отдельная,
                 понятная ошибка вместо общего "неверный логин или пароль".
                 Проверяем ПОСЛЕ сверки пароля, чтобы не палить блокировку
                 тому, кто пароль не знает. */
              if (emp.active === false) {
                return res.status(403).json({ ok: false, error: "account blocked" });
              }
              await clearFailedLogins(lockKey);
              const token = sign({ sub: emp.id, role: emp.role || "accountant", name: emp.name });
              return res.status(200).json({ ok: true, token, role: emp.role || "accountant", name: emp.name });
            }
          }
        }

        /* 3) Старый вариант — сотрудник по произвольному логину (bootstrap_admin и более ранние учётки) */
        const emp = await findEmployeeByLogin(identity);
        if (emp && emp.pwdHash && bcrypt.compareSync(password, emp.pwdHash)) {
          if (emp.active === false) {
            return res.status(403).json({ ok: false, error: "account blocked" });
          }
          await clearFailedLogins(lockKey);
          const token = sign({ sub: emp.id, role: emp.role || "accountant", name: emp.name });
          return res.status(200).json({ ok: true, token, role: emp.role || "accountant", name: emp.name });
        }

        await registerFailedLogin(lockKey);
        return res.status(401).json({ ok: false, error: "invalid credentials" });
      }

      if (body.action === "change_password") {
        const token = getBearer(req);
        const payload = token && verify(token);
        if (!payload || payload.role !== "client") {
          return res.status(401).json({ ok: false, error: "unauthorized" });
        }
        const { currentPassword, newPassword } = body;
        if (!currentPassword || !newPassword || String(newPassword).length < 6) {
          return res.status(200).json({ ok: false, error: "Пароль должен быть не короче 6 символов" });
        }
        const u = await redis.get("user:" + payload.sub);
        if (!u || !u.pwdHash || !bcrypt.compareSync(String(currentPassword), u.pwdHash)) {
          return res.status(200).json({ ok: false, error: "Неверный текущий пароль" });
        }
        u.pwdHash = bcrypt.hashSync(String(newPassword), 10);
        u.pwdPlain = String(newPassword); // для показа в /help бота, как и при обычной выдаче
        await redis.set("user:" + payload.sub, u);
        return res.status(200).json({ ok: true });
      }

      if (body.action === "guest") {
        const token = sign({ sub: "guest:" + crypto.randomBytes(4).toString("hex"), role: "guest", name: "Гость" }, "1d");
        return res.status(200).json({ ok: true, token, role: "guest", name: "Гость" });
      }

      return res.status(200).json({ ok: false, error: "unknown action" });
    }

    res.status(405).json({ ok: false });
  } catch (e) {
    console.error("auth api:", e);
    res.status(200).json({ ok: false, error: String(e).slice(0, 300) });
  }
};
