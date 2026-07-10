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

function resolveOrigin(req) {
  const origin = req.headers.origin || "";
  if (!ALLOWED_ORIGINS.length) return origin || "*";
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}
function checkApiKey(req) {
  if (!API_KEY) return true;
  return req.headers["x-api-key"] === API_KEY;
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
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
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
        if (!process.env.BOOTSTRAP_ADMIN_SECRET || secret !== process.env.BOOTSTRAP_ADMIN_SECRET) {
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

        /* 1) Пробуем клиента по телефону */
        const phone = normPhone(identity);
        if (phone) {
          const telegramId = await redis.get("authphone:" + phone);
          if (telegramId) {
            const u = await redis.get("user:" + telegramId);
            if (u && u.pwdHash && bcrypt.compareSync(password, u.pwdHash)) {
              const token = sign({ sub: String(telegramId), role: "client", company: u.company, phone });
              return res.status(200).json({ ok: true, token, role: "client", name: u.company });
            }
          }

          /* 2) Пробуем сотрудника по телефону (логин сотрудника, заведённого из CRM) */
          const staffId = await redis.get("staffphone:" + phone);
          if (staffId) {
            const emp = await redis.get("employee:" + staffId);
            if (emp && emp.active !== false && emp.pwdHash && bcrypt.compareSync(password, emp.pwdHash)) {
              const token = sign({ sub: emp.id, role: emp.role || "accountant", name: emp.name });
              return res.status(200).json({ ok: true, token, role: emp.role || "accountant", name: emp.name });
            }
          }
        }

        /* 3) Старый вариант — сотрудник по произвольному логину (bootstrap_admin и более ранние учётки) */
        const emp = await findEmployeeByLogin(identity);
        if (emp && emp.active !== false && emp.pwdHash && bcrypt.compareSync(password, emp.pwdHash)) {
          const token = sign({ sub: emp.id, role: emp.role || "accountant", name: emp.name });
          return res.status(200).json({ ok: true, token, role: emp.role || "accountant", name: emp.name });
        }

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
