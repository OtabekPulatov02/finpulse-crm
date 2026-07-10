/* ============================================================
   Finpulse CRM — Telegram-бот (Vercel Serverless + Upstash Redis)

   Клиент: /start → язык (ру/узб/англ) → название компании →
   пишет задачу как обычному бухгалтеру (текст + файлы) →
   одна кнопка «Отправить» → задача уходит в группу бухгалтеров.

   Группа: карточка задачи БЕЗ личных данных клиента, без кнопок —
   исполнитель и статус назначаются только в CRM (канбан/список),
   ответы на карточку пересылаются клиенту и обратно.
   ============================================================ */

const { Bot, webhookCallback, InlineKeyboard } = require("grammy");
const { Redis } = require("@upstash/redis");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

/* Расставляет пробелы-разделители тысяч в суммах внутри произвольного
   текста ("1000000" -> "1 000 000") — в тексте задач и т.п. Идемпотентно,
   поэтому применяется прямо при сохранении, а не в каждом месте показа. */
function formatSumsInText(text) {
  return String(text ?? "").replace(/(?<![+№\d])\d{6,12}(?!\d)/g, (m) =>
    m.replace(/\B(?=(\d{3})+(?!\d))/g, " ")
  );
}

/* ---------------- Доступ клиента в CRM (логин = телефон) ---------------- */
function normPhone(p) {
  return String(p || "").replace(/[^\d+]/g, "");
}
/* Форматирование номера для отображения человеку (в сообщениях бота) —
   "+998935678654" → "+998 93 567 86 54". Хранение/сравнение по-прежнему
   идёт через normPhone(), формат тут только для читаемости. */
function formatPhoneDisplay(p) {
  const digits = String(p || "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("998")) {
    return `+${digits.slice(0, 3)} ${digits.slice(3, 5)} ${digits.slice(5, 8)} ${digits.slice(8, 10)} ${digits.slice(10, 12)}`;
  }
  return String(p || "");
}
function genPassword() {
  // 8 читаемых символов без похожих друг на друга (0/O, 1/l/I)
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  let out = "";
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const CRM_BLOCK_LABEL = {
  ru: { title: "🔐 <b>Доступ в CRM</b>", site: "Сайт", login: "Логин", pass: "Пароль", regen: "используйте команду /password, чтобы получить новый пароль" },
  uz: { title: "🔐 <b>CRM'ga kirish</b>", site: "Sayt", login: "Login", pass: "Parol", regen: "yangi parol olish uchun /password buyrug'ini yuboring" },
  en: { title: "🔐 <b>CRM access</b>", site: "Site", login: "Login", pass: "Password", regen: "send /password to get a new password" },
};

/* Блок с доступами в CRM для подстановки в /help — чтобы не нужно было
   закреплять отдельное сообщение с логином/паролем. */
function crmAccessBlock(u) {
  if (!u || !u.authPhone) return "";
  const lang = u.lang || "ru";
  const L = CRM_BLOCK_LABEL[lang] || CRM_BLOCK_LABEL.ru;
  const passLine = u.pwdPlain ? `<code>${escapeHtml(u.pwdPlain)}</code>` : L.regen;
  return `\n\n${L.title}\n${L.site}: ${process.env.CRM_APP_URL || "https://finpulse-crm-app.vercel.app"}\n${L.login}: <code>${escapeHtml(formatPhoneDisplay(u.authPhone))}</code>\n${L.pass}: ${passLine}`;
}

/* Отправляет сообщение с доступами как HTML (кликабельные code-блоки для
   копирования одним нажатием) и закрепляет его в чате, чтобы клиент не
   потерял логин/пароль в истории переписки. */
async function sendAndPinCreds(ctx, text) {
  const msg = await ctx.reply(text, { parse_mode: "HTML" });
  try {
    await ctx.api.pinChatMessage(ctx.chat.id, msg.message_id, { disable_notification: true });
  } catch (e) { /* бот может быть без прав закрепления — не критично */ }
  return msg;
}
async function ensureClientCredentials(ctx, u) {
  if (!u.phone || u.pwdHash) return null; // уже есть пароль, либо телефон не указан
  return issueClientPassword(ctx, u);
}

/* Проверяет, не привязан ли телефон уже к другому Telegram-аккаунту в CRM,
   прежде чем выдать/перевыпустить пароль. Если тот же клиент сменил
   аккаунт — перепривязываем. Если телефон уже занят ДРУГОЙ компанией —
   не выдаём доступ автоматически и зовём бухгалтеров разобраться. */
async function issueClientPassword(ctx, u) {
  const phone = normPhone(u.phone);
  const existingOwnerId = await redis.get("authphone:" + phone);
  if (existingOwnerId && String(existingOwnerId) !== String(ctx.from.id)) {
    const otherUser = await getUser(existingOwnerId);
    const sameCompany = otherUser && u.company && normCompany(otherUser.company || "") === normCompany(u.company || "");
    if (!sameCompany) {
      await logEvent("telegram", "phone_conflict", {
        phone, company: u.company, otherTelegramId: String(existingOwnerId), otherCompany: otherUser?.company || null,
      });
      const group = await redis.get("group");
      if (group) {
        try {
          await bot.api.sendMessage(group,
            `⚠️ Телефон ${formatPhoneDisplay(phone)} уже привязан к другой карточке в CRM (компания: «${otherUser?.company || "?"}"). ` +
            `Новая регистрация: «${u.company}». Доступ в кабинет не выдан автоматически — нужна проверка вручную в разделе «Клиенты».`);
        } catch (e) { /* noop */ }
      }
      return null;
    }
    /* тот же клиент, новый Telegram-аккаунт — старый логин по этому телефону перестаёт работать */
  }
  const password = genPassword();
  u.pwdHash = bcrypt.hashSync(password, 10);
  u.pwdPlain = password; // хранится, чтобы можно было показать доступ повторно в /help
  u.authPhone = phone;
  await redis.set("authphone:" + phone, ctx.from.id);
  return password;
}

/* ---------------- Реальная карточка клиента (дедуп по телефону/компании) ----------------
   Индексы:
     clientcompany:<normCompany> -> client id
     clientphone:<normPhone>     -> client id
     clients                     -> set всех id
   При конфликте (телефон уже привязан к карточке ДРУГОЙ компании) —
   не сливаем автоматически, а логируем и уведомляем группу. */
async function upsertClient(u, telegramId) {
  if (!u.company) return null;
  const normC = normCompany(u.company);
  const phone = u.phone ? normPhone(u.phone) : null;

  const idByCompany = await redis.get("clientcompany:" + normC);
  const idByPhone = phone ? await redis.get("clientphone:" + phone) : null;

  if (idByCompany && idByPhone && idByCompany !== idByPhone) {
    await logEvent("telegram", "client_conflict", { company: u.company, phone, idByCompany, idByPhone });
    const group = await redis.get("group");
    if (group) {
      try {
        await bot.api.sendMessage(group,
          `⚠️ Похоже на дубликат клиента: «${u.company}» — телефон ${formatPhoneDisplay(phone)} уже привязан к другой карточке. Проверьте вручную в разделе «Клиенты».`);
      } catch (e) { /* noop */ }
    }
    return idByCompany;
  }

  const id = idByCompany || idByPhone;
  if (id) {
    const existing = (await redis.get("client:" + id)) || {};
    const merged = {
      ...existing,
      id,
      company: existing.company || u.company,
      position: existing.position || u.position || null,
      phone: existing.phone || phone,
      telegramId,
      updatedAt: new Date().toISOString(),
    };
    await redis.set("client:" + id, merged);
    if (!idByCompany) await redis.set("clientcompany:" + normC, id);
    if (phone && !idByPhone) await redis.set("clientphone:" + phone, id);
    return id;
  }

  const newId = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const rec = {
    id: newId,
    company: u.company,
    position: u.position || null,
    phone,
    telegramId,
    status: "pending",
    assignedTo: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await redis.set("client:" + newId, rec);
  await redis.set("clientcompany:" + normC, newId);
  if (phone) await redis.set("clientphone:" + phone, newId);
  await redis.sadd("clients", newId);
  return newId;
}

/* ---------------- Тексты интерфейса ---------------- */
const T = {
  ru: {
    askCompany: "Отлично! 🇷🇺\nКак называется ваша компания? Напишите одним сообщением.",
    ready: (c) =>
      `Готово, «${c}»! ✅\n\nТеперь просто напишите вашу задачу или вопрос — так же, как написали бы своему бухгалтеру. Можно сразу приложить файлы или скриншоты 📎`,
    idleHint: "Напишите новую задачу текстом — можно приложить файлы или скриншоты 📎",
    draftPrompt: "Приложите файл/скриншот или отправляйте 👇",
    draftWithFiles: (n) => `📎 Файлов: ${n}. Добавьте ещё или отправляйте 👇`,
    needText: "Добавьте, пожалуйста, короткое текстовое описание задачи — так бухгалтер быстрее поймёт, что нужно сделать ✍️",
    btnSubmit: "🚀 Отправить задачу",
    btnCancel: "✖️ Отменить",
    canceled: "Черновик удалён. Напишите новую задачу, когда будете готовы.",
    created: (n) =>
      `✅ Задача №${n} принята!\n\nМы назначим бухгалтера и напишем вам здесь. Если хотите что-то добавить — ответьте на это сообщение.`,
    assigned: (n, name) => `👩‍💼 По задаче №${n} назначен бухгалтер: ${name}. Уже в работе!`,
    done: (n) => `🎉 Задача №${n} выполнена! Если что-то ещё нужно — просто напишите.`,
    fromAcc: (n) => `💬 Ответ бухгалтера по задаче №${n}:`,
    replyRouted: (n) => `✉️ Передали бухгалтеру (задача №${n}).`,
    help:
      "ℹ️ Как это работает:\n\n1️⃣ Напишите задачу текстом (можно с файлами)\n2️⃣ Нажмите «Отправить задачу»\n3️⃣ Бухгалтер получит её и ответит здесь\n\nКоманды:\n/new — новая задача\n/tasks — мои задачи\n/company — изменить компанию\n/lang — сменить язык\n/help — помощь",
    langSaved: "Язык сохранён 🇷🇺",
    menu: { newTask: "📝 Новая задача", myTasks: "📋 Мои задачи", lang: "🌐 Язык", help: "ℹ️ Помощь" },
    activeTitle: "🔥 Актуальные:",
    historyTitle: "🗂 История:",
    reuseHint: "Нажмите 🔁 чтобы повторить задачу из истории.",
    reuseDraft: (n) => `🔁 Черновик из задачи №${n}. Дополните или отправляйте 👇`,
    noTasks: "У вас пока нет задач. Просто напишите, что нужно сделать 👇",
    askPhone: "И последнее: отправьте номер телефона — по нему мы точно привяжем вас к вашей компании в системе 📱",
    btnShareContact: "📱 Отправить мой номер",
    btnSkip: "Пропустить",
    askPosition: "Подскажите вашу должность в компании (например: главный бухгалтер, директор) ✍️",
    companyConfirm: (m) => `Похоже, вы из этой компании:\n\n🏢 ${m}\n\nВерно?`,
    btnYes: "✅ Да, верно",
    btnNo: "✍️ Нет, другая",
    crmCreds: (login, pass) =>
      `🔐 <b>Доступ в личный кабинет CRM</b>\n\nСайт:\n${process.env.CRM_APP_URL || "https://finpulse-crm-app.vercel.app"}\n\nЛогин (телефон):\n<code>${escapeHtml(formatPhoneDisplay(login))}</code>\n\nПароль:\n<code>${escapeHtml(pass)}</code>\n\nНажмите на логин или пароль, чтобы скопировать. Этот же доступ всегда можно посмотреть командой /help. Сменить пароль — командой /password.`,
    crmPending: "🔐 Этот телефон уже привязан к другой карточке клиента в CRM. Доступ в кабинет выдадим после проверки бухгалтером.",
  },
  uz: {
    askCompany: "Ajoyib! 🇺🇿\nKompaniyangiz nomi qanday? Bitta xabar bilan yozing.",
    ready: (c) =>
      `Tayyor, «${c}»! ✅\n\nEndi vazifangizni yoki savolingizni yozing — xuddi buxgalteringizga yozgandek. Fayl yoki skrinshot ham qo'shishingiz mumkin 📎`,
    idleHint: "Yangi vazifani matn bilan yozing — fayl yoki skrinshot qo'shish mumkin 📎",
    draftPrompt: "Fayl/skrinshot qo'shing yoki yuboring 👇",
    draftWithFiles: (n) => `📎 Fayllar: ${n}. Yana qo'shing yoki yuboring 👇`,
    needText: "Iltimos, vazifaning qisqacha matnli tavsifini qo'shing ✍️",
    btnSubmit: "🚀 Vazifani yuborish",
    btnCancel: "✖️ Bekor qilish",
    canceled: "Qoralama o'chirildi. Tayyor bo'lganingizda yangi vazifa yozing.",
    created: (n) =>
      `✅ №${n} vazifa qabul qilindi!\n\nBuxgalter tayinlaymiz va shu yerda yozamiz. Qo'shimcha ma'lumot bo'lsa — shu xabarga javob yozing.`,
    assigned: (n, name) => `👩‍💼 №${n} vazifaga buxgalter tayinlandi: ${name}. Ishga tushdi!`,
    done: (n) => `🎉 №${n} vazifa bajarildi! Yana savol bo'lsa — yozavering.`,
    fromAcc: (n) => `💬 №${n} vazifa bo'yicha buxgalter javobi:`,
    replyRouted: (n) => `✉️ Buxgalterga yetkazildi (№${n} vazifa).`,
    help:
      "ℹ️ Qanday ishlaydi:\n\n1️⃣ Vazifani matn bilan yozing (fayllar bilan ham bo'ladi)\n2️⃣ «Vazifani yuborish» tugmasini bosing\n3️⃣ Buxgalter uni oladi va shu yerda javob beradi\n\nBuyruqlar:\n/new — yangi vazifa\n/tasks — vazifalarim\n/company — kompaniyani o'zgartirish\n/lang — tilni o'zgartirish\n/help — yordam",
    langSaved: "Til saqlandi 🇺🇿",
    menu: { newTask: "📝 Yangi vazifa", myTasks: "📋 Vazifalarim", lang: "🌐 Til", help: "ℹ️ Yordam" },
    activeTitle: "🔥 Joriy:",
    historyTitle: "🗂 Tarix:",
    reuseHint: "Tarixdagi vazifani takrorlash uchun 🔁 bosing.",
    reuseDraft: (n) => `🔁 №${n} vazifadan qoralama. To'ldiring yoki yuboring 👇`,
    noTasks: "Hozircha vazifalar yo'q. Nima qilish kerakligini yozing 👇",
    askPhone: "Va nihoyat: telefon raqamingizni yuboring — u orqali sizni tizimdagi kompaniyangizga aniq bog'laymiz 📱",
    btnShareContact: "📱 Raqamimni yuborish",
    btnSkip: "O'tkazib yuborish",
    askPosition: "Kompaniyadagi lavozimingizni yozing (masalan: bosh buxgalter, direktor) ✍️",
    companyConfirm: (m) => `Siz shu kompaniyadansiz shekilli:\n\n🏢 ${m}\n\nTo'g'rimi?`,
    btnYes: "✅ Ha, to'g'ri",
    btnNo: "✍️ Yo'q, boshqa",
    crmCreds: (login, pass) =>
      `🔐 <b>CRM shaxsiy kabinetiga kirish</b>\n\nSayt:\n${process.env.CRM_APP_URL || "https://finpulse-crm-app.vercel.app"}\n\nLogin (telefon):\n<code>${escapeHtml(formatPhoneDisplay(login))}</code>\n\nParol:\n<code>${escapeHtml(pass)}</code>\n\nNusxalash uchun login yoki parolga bosing. Bu ma'lumotni /help buyrug'i orqali doim ko'rish mumkin. Parolni o'zgartirish — /password.`,
    crmPending: "🔐 Bu telefon raqami CRM'da boshqa mijoz kartasiga biriktirilgan. Kabinetga kirish buxgalter tekshiruvidan so'ng beriladi.",
  },
  en: {
    askCompany: "Great! 🇬🇧\nWhat is your company name? Send it in one message.",
    ready: (c) =>
      `All set, “${c}”! ✅\n\nNow just write your task or question — the same way you would text your accountant. Feel free to attach files or screenshots 📎`,
    idleHint: "Write a new task as text — you can attach files or screenshots 📎",
    draftPrompt: "Attach a file/screenshot or submit 👇",
    draftWithFiles: (n) => `📎 Files: ${n}. Add more or submit 👇`,
    needText: "Please add a short text description of the task ✍️",
    btnSubmit: "🚀 Submit task",
    btnCancel: "✖️ Cancel",
    canceled: "Draft removed. Write a new task whenever you're ready.",
    created: (n) =>
      `✅ Task #${n} received!\n\nWe'll assign an accountant and message you here. To add anything, just reply to this message.`,
    assigned: (n, name) => `👩‍💼 Task #${n} was assigned to accountant: ${name}. Work has started!`,
    done: (n) => `🎉 Task #${n} is completed! If you need anything else — just write.`,
    fromAcc: (n) => `💬 Accountant's reply on task #${n}:`,
    replyRouted: (n) => `✉️ Forwarded to your accountant (task #${n}).`,
    help:
      "ℹ️ How it works:\n\n1️⃣ Write your task as text (files welcome)\n2️⃣ Tap “Submit task”\n3️⃣ An accountant receives it and replies here\n\nCommands:\n/new — new task\n/tasks — my tasks\n/company — change company\n/lang — change language\n/help — help",
    langSaved: "Language saved 🇬🇧",
    menu: { newTask: "📝 New task", myTasks: "📋 My tasks", lang: "🌐 Language", help: "ℹ️ Help" },
    activeTitle: "🔥 Active:",
    historyTitle: "🗂 History:",
    reuseHint: "Tap 🔁 to reuse a task from history.",
    reuseDraft: (n) => `🔁 Draft from task #${n}. Edit or submit 👇`,
    noTasks: "No tasks yet. Just write what needs to be done 👇",
    askPhone: "One last thing: share your phone number — we use it to link you to your company in our system 📱",
    btnShareContact: "📱 Share my number",
    btnSkip: "Skip",
    askPosition: "What's your position at the company (e.g. chief accountant, director)? ✍️",
    companyConfirm: (m) => `Looks like you are from:\n\n🏢 ${m}\n\nIs that right?`,
    btnYes: "✅ Yes, correct",
    btnNo: "✍️ No, different",
    crmCreds: (login, pass) =>
      `🔐 <b>CRM portal access</b>\n\nSite:\n${process.env.CRM_APP_URL || "https://finpulse-crm-app.vercel.app"}\n\nLogin (phone):\n<code>${escapeHtml(formatPhoneDisplay(login))}</code>\n\nPassword:\n<code>${escapeHtml(pass)}</code>\n\nTap the login or password to copy it. You can always view this again via /help. To change the password, send /password.`,
    crmPending: "🔐 This phone number is already linked to another client record in the CRM. Portal access will be granted after an accountant reviews it.",
  },
};

const LANG_KB = new InlineKeyboard()
  .text("🇷🇺 Русский", "lang:ru")
  .text("🇺🇿 O'zbekcha", "lang:uz")
  .text("🇬🇧 English", "lang:en");

const HELLO =
  "👋 Здравствуйте! Это бот бухгалтерии «Finpulse».\nAssalomu alaykum! Bu «Finpulse» buxgalteriya boti.\nHello! This is the Finpulse accounting bot.\n\nВыберите язык / Tilni tanlang / Choose a language:";

/* ---------------- Хранилище ---------------- */
const userKey = (id) => `user:${id}`;
const taskKey = (n) => `task:${n}`;
const groupRouteKey = (msgId) => `route:g:${msgId}`;
const clientRouteKey = (chatId, msgId) => `route:c:${chatId}:${msgId}`;

async function getUser(id) {
  return (await redis.get(userKey(id))) || null;
}
async function setUser(id, data) {
  await redis.set(userKey(id), data);
}

/* ---------------- Бот ---------------- */
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

const isPrivate = (ctx) => ctx.chat?.type === "private";
const isGroup = (ctx) => ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";

function draftKb(t) {
  return new InlineKeyboard().text(t.btnSubmit, "submit").text(t.btnCancel, "cancel");
}

/* Постоянное меню-клавиатура */
function mainKb(lang) {
  const m = T[lang].menu;
  return {
    keyboard: [
      [{ text: m.newTask }, { text: m.myTasks }],
      [{ text: m.lang }, { text: m.help }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function phoneKb(t) {
  return {
    keyboard: [[{ text: t.btnShareContact, request_contact: true }], [{ text: t.btnSkip }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

/* Нечёткое сопоставление названия компании с базой клиентов */
function normCompany(str) {
  return String(str)
    .toLowerCase()
    .replace(/[«»"'\u2018\u2019\u201c\u201d.,:;()\-–—_/\\]/g, " ")
    .replace(/\b(ооо|оао|зао|ао|ип|чп|мчж|хк|ooo|oao|llc|ltd|inc|mchj|xk|xt)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

async function fuzzyCompany(name) {
  const list = (await redis.smembers("companies")) || [];
  const n = normCompany(name);
  if (!n) return null;
  let best = null, bestD = Infinity;
  for (const c of list) {
    const m = normCompany(c);
    if (!m) continue;
    if (m === n) return { name: c, exact: true };
    if (m.includes(n) || n.includes(m)) {
      const d = Math.abs(m.length - n.length) * 0.5;
      if (d < bestD) { bestD = d; best = c; }
      continue;
    }
    const d = levenshtein(n, m);
    const lim = Math.max(2, Math.floor(Math.min(n.length, m.length) * 0.34));
    if (d <= lim && d < bestD) { bestD = d; best = c; }
  }
  return best ? { name: best, exact: false } : null;
}

async function notifyNewCompany(u) {
  if (!u.isNewCompany) return;
  delete u.isNewCompany;
  await logEvent("telegram", "new_company", { company: u.company, phone: u.phone || null });
  await redis.lpush("pending_clients", JSON.stringify({
    company: u.company,
    phone: u.phone || null,
    at: new Date().toISOString(),
  }));
  const group = await redis.get("group");
  if (group) {
    try {
      await bot.api.sendMessage(
        group,
        "🆕 Новый клиент зарегистрировался в боте\n" +
        "🏢 " + u.company + "\n\n" +
        "Компании нет в базе CRM — создайте карточку, заполните данные и назначьте ответственного. " +
        "Телефон клиента — в списке «Ожидают активации»."
      );
    } catch (e) { console.error("notify new company:", e); }
  }
}

async function afterCompanySet(ctx, u) {
  const t = T[u.lang];
  if (!u.position) {
    u.state = "position";
    await setUser(ctx.from.id, u);
    return ctx.reply(t.askPosition, { reply_markup: { keyboard: [[{ text: t.btnSkip }]], resize_keyboard: true, one_time_keyboard: true } });
  }
  u.state = u.phone ? "idle" : "phone";
  await setUser(ctx.from.id, u);
  if (u.state === "idle") return finishOnboarding(ctx, u);
  return ctx.reply(t.askPhone, { reply_markup: phoneKb(t) });
}

async function finishOnboarding(ctx, u) {
  const t = T[u.lang];
  await notifyNewCompany(u);
  const newPassword = await ensureClientCredentials(ctx, u);
  await upsertClient(u, ctx.from.id);
  await setUser(ctx.from.id, u);
  await ctx.reply(t.ready(u.company), { reply_markup: mainKb(u.lang) });
  if (newPassword) {
    await sendAndPinCreds(ctx, t.crmCreds(u.authPhone, newPassword));
  } else if (u.phone && !u.pwdHash) {
    await ctx.reply(t.crmPending);
  }
  return;
}

const STATUS_EMOJI = { new: "⚪️", in_progress: "🔵", done: "✅" };

/* Журнал событий для CRM (logs:telegram) */
async function logEvent(source, event, data) {
  try {
    await redis.lpush("logs:" + source, JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
    await redis.ltrim("logs:" + source, 0, 499);
  } catch (e) { console.error("log:", e); }
}

/* Отправка длинного текста частями (в пределах лимита Telegram) */
async function sendLong(ctx, text, opts) {
  const LIMIT = 4000;
  if (text.length <= LIMIT) return ctx.reply(text, opts);
  let last;
  for (let i = 0; i < text.length; i += LIMIT) {
    const isLast = i + LIMIT >= text.length;
    last = await ctx.reply(text.slice(i, i + LIMIT), isLast ? opts : undefined);
  }
  return last;
}

async function listTasks(ctx, u) {
  const t = T[u.lang];
  const nums = (await redis.lrange("utasks:" + ctx.from.id, 0, 19)) || [];
  if (!nums.length) return ctx.reply(t.noTasks, { reply_markup: mainKb(u.lang) });

  const active = [], history = [];
  for (const n of nums) {
    const task = await redis.get(taskKey(Number(n)));
    if (!task) continue;
    (task.status === "done" ? history : active).push(task);
  }
  if (!active.length && !history.length) return ctx.reply(t.noTasks, { reply_markup: mainKb(u.lang) });

  const block = (task) =>
    (STATUS_EMOJI[task.status] || "⚪️") + " №" + task.num +
    (task.assignee ? " · 👩‍💼 " + task.assignee : "") +
    "\n" + (task.text || "");

  const parts = [];
  if (active.length) {
    parts.push(t.activeTitle);
    active.slice(0, 5).forEach((x) => parts.push(block(x)));
  }
  if (history.length) {
    if (active.length) parts.push("· · ·");
    parts.push(t.historyTitle);
    history.slice(0, 5).forEach((x) => parts.push(block(x)));
    parts.push(t.reuseHint);
  }

  let opts = { reply_markup: mainKb(u.lang) };
  if (history.length) {
    const kb = new InlineKeyboard();
    history.slice(0, 5).forEach((task, i) => {
      kb.text("🔁 №" + task.num, "reuse:" + task.num);
      if (i % 3 === 2) kb.row();
    });
    opts = { reply_markup: kb };
  }
  return sendLong(ctx, parts.join("\n\n"), opts);
}

function extractFile(msg) {
  if (msg.photo && msg.photo.length) {
    return { kind: "photo", file_id: msg.photo[msg.photo.length - 1].file_id };
  }
  if (msg.document) return { kind: "document", file_id: msg.document.file_id };
  if (msg.video) return { kind: "video", file_id: msg.video.file_id };
  if (msg.voice) return { kind: "voice", file_id: msg.voice.file_id };
  if (msg.audio) return { kind: "audio", file_id: msg.audio.file_id };
  return null;
}

async function sendFileTo(chatId, f, caption) {
  const opts = caption ? { caption } : {};
  if (f.kind === "photo") return bot.api.sendPhoto(chatId, f.file_id, opts);
  if (f.kind === "document") return bot.api.sendDocument(chatId, f.file_id, opts);
  if (f.kind === "video") return bot.api.sendVideo(chatId, f.file_id, opts);
  if (f.kind === "voice") return bot.api.sendVoice(chatId, f.file_id, opts);
  if (f.kind === "audio") return bot.api.sendAudio(chatId, f.file_id, opts);
}

/* ---------------- Команды: личный чат ---------------- */
bot.command("start", async (ctx) => {
  if (!isPrivate(ctx)) return;
  const u = await getUser(ctx.from.id);
  if (u && u.lang && u.company) {
    u.state = "idle";
    u.draft = null;
    await setUser(ctx.from.id, u);
    return ctx.reply(T[u.lang].idleHint, { reply_markup: mainKb(u.lang) });
  }
  await setUser(ctx.from.id, { state: "lang" });
  return ctx.reply(HELLO, { reply_markup: LANG_KB });
});

bot.command("lang", async (ctx) => {
  if (!isPrivate(ctx)) return;
  return ctx.reply(HELLO, { reply_markup: LANG_KB });
});

bot.command("help", async (ctx) => {
  if (!isPrivate(ctx)) return;
  const u = await getUser(ctx.from.id);
  const text = T[u?.lang || "ru"].help + crmAccessBlock(u);
  return ctx.reply(text, { parse_mode: "HTML" });
});

bot.command(["new", "cancel"], async (ctx) => {
  if (!isPrivate(ctx)) return;
  const u = await getUser(ctx.from.id);
  if (!u || !u.lang) return ctx.reply(HELLO, { reply_markup: LANG_KB });
  u.state = "idle";
  u.draft = null;
  await setUser(ctx.from.id, u);
  return ctx.reply(T[u.lang].idleHint, { reply_markup: mainKb(u.lang) });
});

bot.command("tasks", async (ctx) => {
  if (!isPrivate(ctx)) return;
  const u = await getUser(ctx.from.id);
  if (!u || !u.lang) return ctx.reply(HELLO, { reply_markup: LANG_KB });
  return listTasks(ctx, u);
});

bot.command("company", async (ctx) => {
  if (!isPrivate(ctx)) return;
  const u = await getUser(ctx.from.id);
  if (!u || !u.lang) return ctx.reply(HELLO, { reply_markup: LANG_KB });
  u.state = "company";
  await setUser(ctx.from.id, u);
  return ctx.reply(T[u.lang].askCompany);
});

bot.command("password", async (ctx) => {
  if (!isPrivate(ctx)) return;
  const u = await getUser(ctx.from.id);
  if (!u || !u.lang) return ctx.reply(HELLO, { reply_markup: LANG_KB });
  if (!u.phone) return ctx.reply(T[u.lang].askPhone, { reply_markup: phoneKb(T[u.lang]) });
  const password = await issueClientPassword(ctx, u);
  await setUser(ctx.from.id, u);
  if (!password) {
    return ctx.reply(T[u.lang].crmPending);
  }
  return sendAndPinCreds(ctx, T[u.lang].crmCreds(u.authPhone, password));
});

/* ---------------- Команды: группа ---------------- */
bot.command("bind", async (ctx) => {
  if (!isGroup(ctx)) return;
  const code = (ctx.match || "").trim();
  if (!process.env.BIND_CODE || code !== process.env.BIND_CODE) {
    return ctx.reply("❌ Неверный код привязки. Используйте: /bind ВАШ_КОД");
  }
  await redis.set("group", ctx.chat.id);
  return ctx.reply(
    "✅ Группа привязана к Finpulse CRM!\n\nСюда будут приходить новые задачи клиентов. Отвечайте на карточку задачи — ответ уйдёт клиенту."
  );
});

/* ---------------- Выбор языка ---------------- */
bot.callbackQuery(/^lang:(ru|uz|en)$/, async (ctx) => {
  const lang = ctx.match[1];
  const u = (await getUser(ctx.from.id)) || {};
  u.lang = lang;
  if (!u.company) {
    u.state = "company";
    await setUser(ctx.from.id, u);
    await ctx.answerCallbackQuery();
    return ctx.reply(T[lang].askCompany);
  }
  u.state = "idle";
  await setUser(ctx.from.id, u);
  await ctx.answerCallbackQuery(T[lang].langSaved);
  return ctx.reply(T[lang].idleHint, { reply_markup: mainKb(lang) });
});

/* ---------------- Повтор задачи из истории ---------------- */
bot.callbackQuery(/^reuse:(\d+)$/, async (ctx) => {
  const u = await getUser(ctx.from.id);
  if (!u || !u.lang) return ctx.answerCallbackQuery();
  const t = T[u.lang];
  const task = await redis.get(taskKey(Number(ctx.match[1])));
  if (!task) return ctx.answerCallbackQuery("✖️");
  u.state = "draft";
  u.draft = { text: task.text || "", files: task.files || [] };
  await setUser(ctx.from.id, u);
  await ctx.answerCallbackQuery("🔁");
  await logEvent("telegram", "task_reused", { num: task.num, company: task.company });
  return sendLong(
    ctx,
    t.reuseDraft(task.num) + "\n\n«" + (task.text || "") + "»" +
    (u.draft.files.length ? "\n📎 " + u.draft.files.length : ""),
    { reply_markup: draftKb(t) }
  );
});

/* ---------------- Подтверждение компании ---------------- */
bot.callbackQuery(/^comp:(yes|no)$/, async (ctx) => {
  const u = await getUser(ctx.from.id);
  if (!u || u.state !== "confirm_company") return ctx.answerCallbackQuery();
  const t = T[u.lang];
  if (ctx.match[1] === "yes") {
    u.company = u.matchedCompany;
  } else {
    u.company = u.pendingCompany;
    await redis.sadd("companies", u.company);
    u.isNewCompany = true;
  }
  delete u.pendingCompany;
  delete u.matchedCompany;
  await ctx.answerCallbackQuery("🏢 " + u.company);
  return afterCompanySet(ctx, u);
});

/* ---------------- Отправка / отмена задачи ---------------- */
bot.callbackQuery("cancel", async (ctx) => {
  const u = await getUser(ctx.from.id);
  if (!u) return ctx.answerCallbackQuery();
  u.state = "idle";
  u.draft = null;
  await setUser(ctx.from.id, u);
  await ctx.answerCallbackQuery();
  return ctx.reply(T[u.lang].canceled, { reply_markup: mainKb(u.lang) });
});

bot.callbackQuery("submit", async (ctx) => {
  const u = await getUser(ctx.from.id);
  if (!u || !u.draft) return ctx.answerCallbackQuery();
  const t = T[u.lang];
  if (!u.draft.text || !u.draft.text.trim()) {
    await ctx.answerCallbackQuery();
    return ctx.reply(t.needText);
  }

  const n = await redis.incr("counter:task");
  const num = 100 + n;
  const task = {
    num,
    client: ctx.from.id,
    company: u.company,
    text: formatSumsInText(u.draft.text),
    files: u.draft.files || [],
    status: "new",
    assignee: null,
    createdAt: new Date().toISOString(),
  };

  /* Сохраняем задачу сразу — она не потеряется, даже если отправка в группу упадёт */
  await redis.set(taskKey(num), task);
  await redis.lpush("utasks:" + ctx.from.id, num);
  await redis.ltrim("utasks:" + ctx.from.id, 0, 19);
  await logEvent("telegram", "task_created", {
    num,
    company: task.company,
    from: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") + (ctx.from.username ? " @" + ctx.from.username : ""),
    files: task.files.length,
    text: task.text.slice(0, 120),
  });
  u.state = "idle";
  u.draft = null;
  await setUser(ctx.from.id, u);

  /* Подтверждение клиенту */
  await ctx.answerCallbackQuery("✅");
  const confirm = await ctx.reply(t.created(num));
  await redis.set(clientRouteKey(ctx.from.id, confirm.message_id), num);

  /* Карточка в группу бухгалтеров (без личных данных клиента) */
  const group = await redis.get("group");
  if (!group) return;
  try {
    const base = `🆕 Задача №${num}\n🏢 Компания: ${task.company}\n——————————\n`;
    const tail =
      (task.files.length ? `\n📎 Вложений: ${task.files.length}` : "") +
      `\n\n⚪️ Статус: Новая` +
      `\n👉 Назначьте исполнителя и статус — в CRM.`;
    const room = 3900 - base.length - tail.length;
    let body = task.text;
    let rest = "";
    if (body.length > room) {
      rest = body.slice(room);
      body = body.slice(0, room) + "… (продолжение ⬇️)";
    }
    const gm = await bot.api.sendMessage(group, base + body + tail);
    task.gmsg = gm.message_id;
    await redis.set(taskKey(num), task);
    await redis.set(groupRouteKey(gm.message_id), num);

    while (rest.length) {
      const chunk = rest.slice(0, 3900);
      rest = rest.slice(3900);
      const cm = await bot.api.sendMessage(group, "…" + chunk + (rest.length ? "…" : ""), {
        reply_to_message_id: gm.message_id,
      });
      await redis.set(groupRouteKey(cm.message_id), num);
    }

    for (const f of task.files) {
      const fm = await sendFileTo(group, f, `📎 к задаче №${num}`);
      if (fm) await redis.set(groupRouteKey(fm.message_id), num);
    }
  } catch (e) {
    console.error("group send:", e);
    await logEvent("telegram", "group_send_failed", { num, error: String(e).slice(0, 200) });
  }
});

/* ---------------- Кнопки в группе (устарело) ----------------
   Раньше отсюда меняли статус/исполнителя прямо в Telegram — теперь это
   делается только в CRM (канбан/список), чтобы не путать данные между
   двумя источниками. Новые карточки кнопок больше не содержат; эти
   обработчики оставлены только на случай, если кто-то нажмёт кнопку на
   уже отправленной ранее (старой) карточке — просто вежливо отправляем
   в CRM, ничего не меняя. */
bot.callbackQuery(/^take:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Назначение исполнителя теперь только в CRM", show_alert: false });
});

bot.callbackQuery(/^done:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Смена статуса теперь только в CRM", show_alert: false });
});

/* ---------------- Автоответчик Telegram Business ---------------- */
bot.on("business_message", async (ctx) => {
  const msg = ctx.businessMessage;
  if (!msg || !msg.from || !msg.chat) return;
  if (msg.from.id !== msg.chat.id) return; // пишет владелец аккаунта — молчим
  const key = "bizgreet:" + msg.chat.id;
  if (await redis.get(key)) return; // уже приветствовали недавно
  await redis.set(key, 1, { ex: 60 * 60 * 24 * 7 });
  const username = (bot.botInfo && bot.botInfo.username) || "finpulse_crm_bot";
  const text =
    "👋 Здравствуйте! Это бухгалтерия Finpulse.\n\n" +
    "Чтобы мы быстрее взяли вашу задачу в работу, отправьте её нашему боту — он мгновенно назначит специалиста и пришлёт номер задачи 👇\n\n" +
    "Assalomu alaykum! Vazifangizni botimizga yuboring — darhol mutaxassis tayinlanadi 👇";
  const kb = new InlineKeyboard().url("🚀 @" + username, "https://t.me/" + username);
  try { await ctx.reply(text, { reply_markup: kb }); } catch (e) { console.error("biz reply:", e); }
});

/* ---------------- Сообщения ---------------- */
bot.on("message", async (ctx) => {
  const msg = ctx.message;

  /* --- Группа: ответ бухгалтера на карточку задачи → клиенту --- */
  if (isGroup(ctx)) {
    const group = await redis.get("group");
    if (!group || ctx.chat.id !== Number(group)) return;
    if (!msg.reply_to_message) return;
    const num = await redis.get(groupRouteKey(msg.reply_to_message.message_id));
    if (!num) return;
    const task = await redis.get(taskKey(Number(num)));
    if (!task) return;

    const clientLang = (await getUser(task.client))?.lang || "ru";
    const label = await bot.api.sendMessage(task.client, T[clientLang].fromAcc(task.num));
    await redis.set(clientRouteKey(task.client, label.message_id), task.num);
    const copied = await bot.api.copyMessage(task.client, ctx.chat.id, msg.message_id);
    await redis.set(clientRouteKey(task.client, copied.message_id), task.num);
    return;
  }

  if (!isPrivate(ctx)) return;

  /* --- Личный чат клиента --- */
  let u = await getUser(ctx.from.id);
  if (!u || !u.lang) {
    await setUser(ctx.from.id, { state: "lang" });
    return ctx.reply(HELLO, { reply_markup: LANG_KB });
  }
  const t = T[u.lang];

  /* Онбординг: название компании (с нечётким поиском по базе) */
  if (u.state === "company") {
    const name = (msg.text || msg.caption || "").trim().slice(0, 120);
    if (!name) return ctx.reply(t.askCompany);
    const match = await fuzzyCompany(name);
    if (match && !match.exact) {
      u.pendingCompany = name;
      u.matchedCompany = match.name;
      u.state = "confirm_company";
      await setUser(ctx.from.id, u);
      const kb = new InlineKeyboard().text(t.btnYes, "comp:yes").text(t.btnNo, "comp:no");
      return ctx.reply(t.companyConfirm(match.name), { reply_markup: kb });
    }
    u.company = match ? match.name : name;
    if (!match) {
      await redis.sadd("companies", u.company);
      u.isNewCompany = true;
    }
    return afterCompanySet(ctx, u);
  }

  /* Онбординг: должность контактного лица */
  if (u.state === "position") {
    const txt = (msg.text || "").trim();
    const isSkip = Object.keys(T).some((l) => txt === T[l].btnSkip);
    if (!isSkip && txt) u.position = txt.slice(0, 80);
    u.state = u.phone ? "idle" : "phone";
    await setUser(ctx.from.id, u);
    if (u.state === "idle") return finishOnboarding(ctx, u);
    return ctx.reply(t.askPhone, { reply_markup: phoneKb(t) });
  }

  /* Онбординг: телефон для привязки к CRM */
  if (u.state === "phone") {
    let phone = null;
    let isPhoneStep = true;
    if (msg.contact && msg.contact.phone_number) {
      phone = msg.contact.phone_number;
    } else {
      const txt = (msg.text || "").trim();
      const isSkip = Object.keys(T).some((l) => txt === T[l].btnSkip);
      if (!isSkip) {
        if (/^\+?[\d\s\-()]{7,18}$/.test(txt)) phone = txt.replace(/[\s\-()]/g, "");
        else isPhoneStep = false; // это не телефон — клиент уже пишет задачу, не блокируем
      }
    }
    if (isPhoneStep) {
      if (phone) u.phone = phone;
      u.state = "idle";
      return finishOnboarding(ctx, u);
    }
    u.state = "idle";
    await notifyNewCompany(u);
    await setUser(ctx.from.id, u);
    // продолжаем обработку этого же сообщения ниже (меню/черновик)
  }

  /* Кнопки главного меню */
  const plain = (msg.text || "").trim();
  if (plain) {
    for (const lng of Object.keys(T)) {
      const M = T[lng].menu;
      if (plain === M.newTask) {
        u.state = "idle"; u.draft = null;
        await setUser(ctx.from.id, u);
        return ctx.reply(t.idleHint, { reply_markup: mainKb(u.lang) });
      }
      if (plain === M.myTasks) return listTasks(ctx, u);
      if (plain === M.lang) return ctx.reply(HELLO, { reply_markup: LANG_KB });
      if (plain === M.help) return ctx.reply(t.help + crmAccessBlock(u), { parse_mode: "HTML", reply_markup: mainKb(u.lang) });
    }
  }

  /* Ответ клиента по существующей задаче → в группу */
  if (msg.reply_to_message) {
    const num = await redis.get(
      clientRouteKey(ctx.chat.id, msg.reply_to_message.message_id)
    );
    if (num) {
      const task = await redis.get(taskKey(Number(num)));
      const group = await redis.get("group");
      if (task && group) {
        const opts = task.gmsg ? { reply_to_message_id: task.gmsg } : {};
        const label = await bot.api.sendMessage(
          group,
          `💬 Клиент по задаче №${task.num} (${task.company}):`,
          opts
        );
        await redis.set(groupRouteKey(label.message_id), task.num);
        const copied = await bot.api.copyMessage(group, ctx.chat.id, msg.message_id);
        await redis.set(groupRouteKey(copied.message_id), task.num);
        return ctx.reply(t.replyRouted(task.num));
      }
    }
  }

  /* Быстрый флоу создания задачи */
  const text = (msg.text || msg.caption || "").trim();
  const file = extractFile(msg);

  if (u.state !== "draft") {
    u.state = "draft";
    u.draft = { text: "", files: [] };
  }
  if (text) u.draft.text = u.draft.text ? u.draft.text + "\n" + text : text;
  if (file && u.draft.files.length < 10) u.draft.files.push(file);
  await setUser(ctx.from.id, u);

  if (!u.draft.text) return ctx.reply(t.needText, { reply_markup: draftKb(t) });
  const prompt = u.draft.files.length
    ? t.draftWithFiles(u.draft.files.length)
    : t.draftPrompt;
  return ctx.reply(prompt, { reply_markup: draftKb(t) });
});

/* ---------------- Профиль бота (описания и команды) ---------------- */
const PROFILE = {
  commands: {
    ru: [
      { command: "new", description: "📝 Новая задача" },
      { command: "tasks", description: "📋 Мои задачи" },
      { command: "company", description: "🏢 Изменить компанию" },
      { command: "lang", description: "🌐 Сменить язык" },
      { command: "help", description: "ℹ️ Помощь" },
    ],
    uz: [
      { command: "new", description: "📝 Yangi vazifa" },
      { command: "tasks", description: "📋 Vazifalarim" },
      { command: "company", description: "🏢 Kompaniyani o'zgartirish" },
      { command: "lang", description: "🌐 Tilni o'zgartirish" },
      { command: "help", description: "ℹ️ Yordam" },
    ],
    en: [
      { command: "new", description: "📝 New task" },
      { command: "tasks", description: "📋 My tasks" },
      { command: "company", description: "🏢 Change company" },
      { command: "lang", description: "🌐 Change language" },
      { command: "help", description: "ℹ️ Help" },
    ],
  },
  description: {
    ru: "👋 Бот бухгалтерии Finpulse\n\n📝 Отправьте задачу так же, как написали бы своему бухгалтеру: текстом, с файлами или скриншотами.\n👩‍💼 Мы сразу назначим специалиста и пришлём номер задачи.\n🔔 Статусы и ответы бухгалтера приходят прямо в этот чат.\n🌐 Русский · O'zbekcha · English",
    uz: "👋 Finpulse buxgalteriya boti\n\n📝 Vazifani xuddi buxgalteringizga yozgandek yuboring: matn, fayl yoki skrinshot bilan.\n👩‍💼 Darhol mutaxassis tayinlaymiz va vazifa raqamini yuboramiz.\n🔔 Holatlar va javoblar shu chatga keladi.\n🌐 Русский · O'zbekcha · English",
    en: "👋 Finpulse accounting bot\n\n📝 Send a task just like you would text your accountant: text, files or screenshots.\n👩‍💼 We assign a specialist right away and send you the task number.\n🔔 Statuses and replies arrive in this chat.\n🌐 Русский · O'zbekcha · English",
  },
  short: {
    ru: "Задачи для вашей бухгалтерии: текст + файлы, статусы и ответы — прямо в Telegram.",
    uz: "Buxgalteriya vazifalari: matn + fayllar, holatlar va javoblar — Telegramda.",
    en: "Send tasks to your accountants: text + files, statuses and replies — in Telegram.",
  },
};

async function setupBotProfile() {
  const done = [];
  await bot.api.setMyCommands(PROFILE.commands.ru);
  for (const lng of ["ru", "uz", "en"]) {
    await bot.api.setMyCommands(PROFILE.commands[lng], { language_code: lng });
  }
  done.push("commands");
  await bot.api.raw.setMyDescription({ description: PROFILE.description.ru });
  for (const lng of ["ru", "uz", "en"]) {
    await bot.api.raw.setMyDescription({ description: PROFILE.description[lng], language_code: lng });
  }
  done.push("description");
  await bot.api.raw.setMyShortDescription({ short_description: PROFILE.short.ru });
  for (const lng of ["ru", "uz", "en"]) {
    await bot.api.raw.setMyShortDescription({ short_description: PROFILE.short[lng], language_code: lng });
  }
  done.push("short_description");
  const hookUrl = "https://finpulse-crm.vercel.app/api/bot";
  await bot.api.setWebhook(hookUrl, {
    allowed_updates: ["message", "callback_query", "business_connection", "business_message"],
    secret_token: process.env.TG_WEBHOOK_SECRET || undefined,
  });
  done.push("webhook(business)");
  await redis.sadd(
    "companies",
    "ООО «ТехноСфера»", "ИП Соколова А. В.", "ООО «СтройГарант»",
    "АО «ВекторПлюс»", "ООО «Логистик Групп»", "ООО «МедФарм»", "ООО «АгроТрейд»"
  );
  done.push("companies");
  return done;
}

/* ---------------- Vercel handler ---------------- */
const handleUpdate = webhookCallback(bot, "http", {
  secretToken: process.env.TG_WEBHOOK_SECRET || undefined,
});

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    const q = req.query || {};
    if (q.setup && process.env.BIND_CODE && q.setup === process.env.BIND_CODE) {
      try {
        const done = await setupBotProfile();
        res.status(200).json({ ok: true, setup: done, message: "Профиль бота обновлён: команды, описание, короткое описание (ru/uz/en)" });
      } catch (e) {
        res.status(200).json({ ok: false, error: String(e) });
      }
      return;
    }
    res.status(200).json({ ok: true, service: "Finpulse CRM Telegram bot" });
    return;
  }
  try {
    await handleUpdate(req, res);
  } catch (e) {
    console.error("bot error:", e);
    if (!res.writableEnded) res.status(200).json({ ok: true });
  }
};
