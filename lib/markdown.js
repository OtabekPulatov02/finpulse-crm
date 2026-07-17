/* ============================================================
   Finpulse CRM — конвертация лёгкого markdown (как отдаёт LLM)
   в Telegram HTML (parse_mode: "HTML"). Вынесено из api/bot.js
   в отдельный модуль без побочных эффектов при require, чтобы
   было можно тестировать без поднятия бота/Redis.
   ============================================================ */
function escapeHtmlMd(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mdToTelegramHtml(text) {
  const lines = String(text ?? "").split("\n");
  return lines.map((line) => {
    const trimmed = line.trimStart();
    const isBullet = /^[-*]\s+/.test(trimmed);
    const content = isBullet ? trimmed.replace(/^[-*]\s+/, "") : line;
    let escaped = escapeHtmlMd(content);
    escaped = escaped.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`(.+?)`/g, "<code>$1</code>");
    return (isBullet ? "• " : "") + escaped;
  }).join("\n");
}

module.exports = { mdToTelegramHtml };
