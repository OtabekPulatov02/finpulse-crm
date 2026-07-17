/* Транскрипция голосовых сообщений Telegram через OpenAI Whisper.
   Задача #12 из инфраструктурного бэклога: клиенты любят наговаривать
   заявку голосом — переводим её в текст перед обычным AI-разбором,
   дальше она идёт по тому же конвейеру, что и обычный текст. */
const KEY = () => process.env.OPENAI_API_KEY || "";

/* file_id → путь на серверах Telegram → сами байты файла. */
async function fetchTelegramFile(botApi, fileId) {
  const file = await botApi.getFile(fileId);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("telegram file download failed: " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  return { buf, ext: (file.file_path.split(".").pop() || "oga") };
}

/* Отправка байтов в OpenAI /v1/audio/transcriptions (модель whisper-1). */
async function transcribeBuffer(buf, ext) {
  if (!KEY()) throw new Error("OPENAI_API_KEY is not set");
  const form = new FormData();
  const blob = new Blob([buf], { type: "audio/ogg" });
  form.append("file", blob, "voice." + (ext || "oga"));
  form.append("model", "whisper-1");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY()}` },
    body: form,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error("whisper transcription failed: " + r.status + " " + t.slice(0, 200));
  }
  const data = await r.json();
  return (data.text || "").trim();
}

/* Основная функция: file_id голосового сообщения → распознанный текст. */
async function transcribeVoiceMessage(botApi, fileId) {
  const { buf, ext } = await fetchTelegramFile(botApi, fileId);
  return transcribeBuffer(buf, ext);
}

module.exports = { transcribeVoiceMessage, transcribeBuffer, fetchTelegramFile };
