/* ============================================================
   Finpulse CRM — ежедневный бэкап Redis в GitHub.

   Вызывается Vercel Cron раз в сутки (см. vercel.json). Собирает
   JSON-снимок всех продуктовых данных (lib/backupExport.js) и
   коммитит его в отдельный приватный GitHub-репозиторий через
   Contents API — так у нас появляется независимая от Upstash копия
   данных с историей версий (каждый день — новый коммит/файл, git
   сам хранит историю изменений).

   Нужные env:
     GITHUB_BACKUP_TOKEN — fine-grained PAT с правом Contents:Write
                            только на репозиторий бэкапов
     GITHUB_BACKUP_REPO  — "owner/repo", например
                            "OtabekPulatov02/finpulse-crm-backups"
   Без них крон не падает молча — шлёт алерт в Telegram-группу и
   возвращает ok:false, чтобы это было видно в логах.

   Хранится последние 30 ежедневных снимков (backups/YYYY-MM-DD.json),
   более старые файлы удаляются в том же прогоне.
   ============================================================ */

const redis = require("../../lib/redisClient.js");
const { exportSnapshot } = require("../../lib/backupExport.js");


const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET || "";
const GH_TOKEN = process.env.GITHUB_BACKUP_TOKEN || "";
const GH_REPO = process.env.GITHUB_BACKUP_REPO || "";
const KEEP_DAYS = 30;

async function tgToGroup(payload) {
  if (!TG_TOKEN) return null;
  const group = await redis.get("group");
  if (!group) return null;
  const call = (chatId) =>
    fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, parse_mode: "HTML", ...payload }),
    }).then((r) => r.json()).catch(() => null);
  let resp = await call(Number(group));
  if (resp && !resp.ok && resp.parameters && resp.parameters.migrate_to_chat_id) {
    const newId = resp.parameters.migrate_to_chat_id;
    await redis.set("group", newId);
    resp = await call(Number(newId));
  }
  return resp;
}

function timingSafeStringEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function ghApi(path, opts) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "content-type": "application/json",
      ...(opts && opts.headers),
    },
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* noop */ }
  return { status: r.status, json, text };
}

async function pushSnapshot(fileName, contentObj) {
  const path = `backups/${fileName}`;
  // узнаём sha существующего файла (если есть) — GitHub требует его для перезаписи
  const existing = await ghApi(`/repos/${GH_REPO}/contents/${path}`, { method: "GET" });
  const sha = existing.status === 200 && existing.json ? existing.json.sha : undefined;
  const content = Buffer.from(JSON.stringify(contentObj, null, 2)).toString("base64");
  const put = await ghApi(`/repos/${GH_REPO}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `backup: ${fileName}`,
      content,
      ...(sha ? { sha } : {}),
    }),
  });
  return put;
}

async function pruneOld() {
  const list = await ghApi(`/repos/${GH_REPO}/contents/backups`, { method: "GET" });
  if (list.status !== 200 || !Array.isArray(list.json)) return { pruned: 0 };
  const files = list.json
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f.name))
    .sort((a, b) => (a.name < b.name ? 1 : -1)); // новые первыми
  const toDelete = files.slice(KEEP_DAYS);
  let pruned = 0;
  for (const f of toDelete) {
    const del = await ghApi(`/repos/${GH_REPO}/contents/backups/${f.name}`, {
      method: "DELETE",
      body: JSON.stringify({ message: `backup: prune ${f.name}`, sha: f.sha }),
    });
    if (del.status === 200) pruned++;
  }
  return { pruned, kept: files.length - pruned };
}

module.exports = async (req, res) => {
  if (CRON_SECRET) {
    const auth = req.headers.authorization || "";
    if (!timingSafeStringEqual(auth, `Bearer ${CRON_SECRET}`)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
  }

  if (!GH_TOKEN || !GH_REPO) {
    await tgToGroup({ text: "🔴 <b>Бэкап Redis не выполнен</b>\n\nНе заданы env GITHUB_BACKUP_TOKEN / GITHUB_BACKUP_REPO — бэкап пропущен." });
    return res.status(200).json({ ok: false, error: "GITHUB_BACKUP_TOKEN/GITHUB_BACKUP_REPO не заданы" });
  }

  try {
    const snapshot = await exportSnapshot(redis);
    const fileName = `${new Date().toISOString().slice(0, 10)}.json`;
    const push = await pushSnapshot(fileName, snapshot);

    if (push.status !== 200 && push.status !== 201) {
      await tgToGroup({
        text: `🔴 <b>Бэкап Redis упал</b>\n\nGitHub API вернул ${push.status} при сохранении ${fileName}.\n${(push.text || "").slice(0, 300)}`,
      });
      return res.status(200).json({ ok: false, status: push.status, body: push.json || push.text });
    }

    const prune = await pruneOld();

    return res.status(200).json({
      ok: true,
      file: fileName,
      savedKeys: snapshot.meta.savedKeys,
      skippedKeys: snapshot.meta.skippedKeys.length,
      prune,
    });
  } catch (e) {
    await tgToGroup({ text: `🔴 <b>Бэкап Redis упал целиком</b>\n\n${String(e).slice(0, 300)}` });
    return res.status(200).json({ ok: false, error: String(e) });
  }
};
