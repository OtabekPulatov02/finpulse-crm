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

if (!process.env.TG_WEBHOOK_SECRET) {
  console.warn("SECURITY: TG_WEBHOOK_SECRET не задан — вебхук бота не проверяет, что запрос действительно пришёл от Telegram.");
} else if (process.env.TG_WEBHOOK_SECRET.length < 32) {
  console.warn("SECURITY: TG_WEBHOOK_SECRET короче 32 символов — увеличьте длину секрета.");
}
if (process.env.BIND_CODE && process.env.BIND_CODE.length < 20) {
  console.warn("SECURITY: BIND_CODE короче 20 символов — увеличьте длину секрета.");
}

/* Сравнение секретов за постоянное время (BIND_CODE и т.п.) — обычное
   === теоретически позволяет измерять тайминг посимвольного сравнения. */
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  if (bufA.length !== bufB.length) return false;
  try { return crypto.timingSafeEqual(bufA, bufB); } catch { return false; }
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

/* Триггер автономного ИИ-бухгалтера сразу после создания задачи через бота —
   зеркалит такой же вызов в api/crm.js. Сам /api/ai проверяет тублер
   ai:settings.autoWork и молча выходит, если он выключен. */
const AUTOWORK_API_ORIGIN = process.env.CRM_API_ORIGIN || "https://finpulse-crm.vercel.app";
async function triggerAutoWork(num, extraContext, aiqInfo) {
  const JWT_SECRET = process.env.JWT_SECRET || process.env.CRM_JWT_SECRET || "";
  if (!JWT_SECRET) return;
  try {
    const jwt = require("jsonwebtoken");
    const token = jwt.sign({ role: "admin", name: "Bot (авто-триггер)" }, JWT_SECRET, { algorithm: "HS256", expiresIn: "3m" });
    await fetch(`${AUTOWORK_API_ORIGIN}/api/ai`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "auto_work", num, ...(extraContext ? { extraContext } : {}), ...(aiqInfo ? { aiqInfo } : {}) }),
      signal: AbortSignal.timeout(55000),
    });
  } catch (e) { console.error("triggerAutoWork:", num, String(e).slice(0, 200)); }
}

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

  /* Верификация принадлежности к компании: доступ в CRM привязывается к
     компании ПО НАЗВАНИЮ, которое человек сам вводит в чате с ботом — это
     не секрет и не проверяется ничем, кроме нечёткого совпадения с уже
     существующими компаниями. Если по этой компании уже есть реальная
     карточка клиента (client:<id>) с известным телефоном, а сейчас
     регистрируется кто-то с ДРУГИМ телефоном — не выдаём пароль
     автоматически. Иначе любой, кто просто знает название чужой компании,
     мог бы получить логин/пароль в CRM от её имени. */
  if (u.company) {
    try {
      const existingClientId = await redis.get("clientcompany:" + normCompany(u.company));
      if (existingClientId) {
        const existingClient = await redis.get("client:" + existingClientId);
        const knownPhone = existingClient && existingClient.phone ? normPhone(existingClient.phone) : null;
        if (knownPhone && knownPhone !== phone) {
          await logEvent("telegram", "company_claim_phone_mismatch", {
            company: u.company, claimedPhone: phone, knownPhone, telegramId: ctx.from.id,
          });
          await addAccessRequest("phone_mismatch", {
            company: u.company, claimedPhone: phone, knownPhone,
            telegramId: ctx.from.id,
            tgName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") + (ctx.from.username ? " @" + ctx.from.username : ""),
          });
          try {
            await sendToGroup((gid) => bot.api.sendMessage(gid,
              `⚠️ <b>Конфликт доступа</b>\nКто-то представился клиентом «<b>${escapeHtml(u.company)}</b>» с телефоном <b>${formatPhoneDisplay(phone)}</b>, ` +
              `но в карточке указан другой: <b>${formatPhoneDisplay(knownPhone)}</b>.\n` +
              `Доступ не выдан автоматически — 👉 <i>проверьте в CRM → Клиенты → Заявки на доступ</i>.`, { parse_mode: "HTML" }));
          } catch (e) { /* noop */ }
          return null;
        }
      }
    } catch (e) { /* сбой проверки не должен блокировать легитимных новых клиентов */ }
  }

  const existingOwnerId = await redis.get("authphone:" + phone);
  if (existingOwnerId && String(existingOwnerId) !== String(ctx.from.id)) {
    const otherUser = await getUser(existingOwnerId);
    const sameCompany = otherUser && u.company && normCompany(otherUser.company || "") === normCompany(u.company || "");
    if (!sameCompany) {
      await logEvent("telegram", "phone_conflict", {
        phone, company: u.company, otherTelegramId: String(existingOwnerId), otherCompany: otherUser?.company || null,
      });
      await addAccessRequest("phone_conflict", {
        company: u.company, claimedPhone: phone, otherCompany: otherUser?.company || null,
        telegramId: ctx.from.id,
        tgName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") + (ctx.from.username ? " @" + ctx.from.username : ""),
      });
      try {
        await sendToGroup((gid) => bot.api.sendMessage(gid,
          `⚠️ <b>Конфликт телефона</b>\n<b>${formatPhoneDisplay(phone)}</b> уже привязан к «<b>${escapeHtml(otherUser?.company || "?")}</b>», ` +
          `новая регистрация: «<b>${escapeHtml(u.company)}</b>».\nДоступ не выдан — 👉 <i>проверьте в CRM → Клиенты → Заявки на доступ</i>.`, { parse_mode: "HTML" }));
      } catch (e) { /* noop */ }
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
    try {
      await sendToGroup((gid) => bot.api.sendMessage(gid,
        `⚠️ <b>Возможный дубликат клиента</b>\n«<b>${escapeHtml(u.company)}</b>» — телефон <b>${formatPhoneDisplay(phone)}</b> уже привязан к другой карточке.\n👉 <i>Проверьте в CRM → Клиенты</i>.`, { parse_mode: "HTML" }));
    } catch (e) { /* noop */ }
    return idByCompany;
  }

  const id = idByCompany || idByPhone;
  if (id) {
    const existing = (await redis.get("client:" + id)) || {};

    /* Не переключаем telegramId (а значит — куда уходят уведомления и от
       чьего имени создаются задачи) молча, если карточка уже привязана к
       ДРУГОМУ Telegram-аккаунту, а телефон нового обращения не совпадает
       с уже известным телефоном клиента. Компания в этом чате — просто
       текст, который ввёл пользователь, и без проверки телефона это не
       доказывает, что это тот же самый клиент. */
    const knownPhone = existing.phone ? normPhone(existing.phone) : null;
    const telegramChanged = existing.telegramId && String(existing.telegramId) !== String(telegramId);
    const ownershipVerified = !knownPhone || (phone && knownPhone === phone);

    if (telegramChanged && !ownershipVerified) {
      await logEvent("telegram", "client_telegram_claim_mismatch", {
        clientId: id, company: u.company, existingTelegramId: existing.telegramId, claimedTelegramId: telegramId, phone,
      });
      await addAccessRequest("telegram_rebind", {
        company: existing.company || u.company, clientId: id, claimedPhone: phone || null,
        existingTelegramId: String(existing.telegramId), telegramId,
        tgName: null,
      });
      try {
        await sendToGroup((gid) => bot.api.sendMessage(gid,
          `⚠️ <b>Смена Telegram-аккаунта</b>\nНовый аккаунт представился клиентом «<b>${escapeHtml(existing.company || u.company)}</b>», но карточка привязана к другому.\n` +
          `Уведомления <b>не переключены</b> — 👉 <i>подтвердите в CRM → Клиенты → Заявки на доступ</i>.`, { parse_mode: "HTML" }));
      } catch (e) { /* noop */ }
      const mergedSafe = {
        ...existing,
        id,
        company: existing.company || u.company,
        position: existing.position || u.position || null,
        phone: existing.phone || phone,
        updatedAt: new Date().toISOString(),
        /* telegramId сознательно НЕ обновляем */
      };
      await redis.set("client:" + id, mergedSafe);
      if (!idByCompany) await redis.set("clientcompany:" + normC, id);
      if (phone && !idByPhone) await redis.set("clientphone:" + phone, id);
      return id;
    }

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
      `Готово, «${c}»! ✅\n\nВыберите услугу из меню ниже — или напишите любое сообщение, и меню появится само. Файлы и скриншоты можно приложить после выбора 📎`,
    idleHint: "Нажмите «📝 Новая задача» и выберите услугу — или просто напишите, меню появится само 👇",
    draftPrompt: "Приложите файл/скриншот или отправляйте 👇",
    draftWithFiles: (n) => `📎 Файлов: ${n}. Добавьте ещё или отправляйте 👇`,
    needText: "Добавьте, пожалуйста, короткое текстовое описание задачи — так бухгалтер быстрее поймёт, что нужно сделать ✍️",
    btnSubmit: "🚀 Отправить задачу",
    btnCancel: "✖️ Отменить",
    canceled: "Черновик удалён. Когда будете готовы — нажмите «📝 Новая задача» 👇",
    created: (n) =>
      `✅ Задача №${n} принята!\n\nМы назначим бухгалтера и напишем вам здесь. Если хотите что-то добавить — ответьте на это сообщение.`,
    assigned: (n, name) => `👩‍💼 По задаче №${n} назначен бухгалтер: ${name}. Уже в работе!`,
    done: (n) => `🎉 Задача №${n} выполнена! Если что-то ещё нужно — просто напишите.`,
    fromAcc: (n) => `💬 Ответ бухгалтера по задаче №${n}:`,
    replyRouted: (n) => `✉️ Передали бухгалтеру (задача №${n}).`,
    help:
      "ℹ️ <b>Как это работает</b>\n\n1️⃣ Выберите услугу из меню (для свободной задачи — «📝 Другое»)\n2️⃣ Опишите детали, приложите файлы и нажмите «Отправить»\n3️⃣ Бухгалтер получит задачу и ответит здесь же\n\n<b>Команды:</b>\n/new — новая задача\n/tasks — мои задачи\n/company — изменить компанию\n/lang — сменить язык\n/help — помощь",
    langSaved: "Язык сохранён 🇷🇺",
    menu: { newTask: "📝 Новая задача", myTasks: "📋 Мои задачи", lang: "🌐 Язык", help: "ℹ️ Помощь" },
    activeTitle: "🔥 <b>Актуальные</b>",
    historyTitle: "🗂 <b>История</b>",
    reuseHint: "Нажмите 🔁 чтобы повторить задачу из истории.",
    reuseDraft: (n) => `🔁 Черновик из задачи №${n}. Дополните или отправляйте 👇`,
    noTasks: "У вас пока нет задач. Нажмите «📝 Новая задача» и выберите услугу 👇",
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
    idleHint: "«📝 Yangi vazifa» tugmasini bosib xizmatni tanlang — yoki shunchaki yozing, menyu o'zi chiqadi 👇",
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
      "ℹ️ <b>Qanday ishlaydi</b>\n\n1️⃣ Menyudan xizmatni tanlang (erkin vazifa uchun — «📝 Boshqa»)\n2️⃣ Tafsilotlarni yozing, fayl qo'shing va «Yuborish» tugmasini bosing\n3️⃣ Buxgalter vazifani oladi va shu yerda javob beradi\n\n<b>Buyruqlar:</b>\n/new — yangi vazifa\n/tasks — vazifalarim\n/company — kompaniyani o'zgartirish\n/lang — tilni o'zgartirish\n/help — yordam",
    langSaved: "Til saqlandi 🇺🇿",
    menu: { newTask: "📝 Yangi vazifa", myTasks: "📋 Vazifalarim", lang: "🌐 Til", help: "ℹ️ Yordam" },
    activeTitle: "🔥 Joriy:",
    historyTitle: "🗂 <b>Tarix</b>",
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
    idleHint: "Tap “📝 New task” and pick a service — or just type, the menu will appear 👇",
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
      "ℹ️ <b>How it works</b>\n\n1️⃣ Pick a service from the menu (for a free-form task — “📝 Other”)\n2️⃣ Describe details, attach files and tap “Submit”\n3️⃣ An accountant receives it and replies right here\n\n<b>Commands:</b>\n/new — new task\n/tasks — my tasks\n/company — change company\n/lang — change language\n/help — help",
    langSaved: "Language saved 🇬🇧",
    menu: { newTask: "📝 New task", myTasks: "📋 My tasks", lang: "🌐 Language", help: "ℹ️ Help" },
    activeTitle: "🔥 <b>Active</b>",
    historyTitle: "🗂 <b>History</b>",
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
  .text("🇷🇺 Русский", "lang:ru").row()
  .text("🇺🇿 O'zbekcha", "lang:uz").row()
  .text("🇬🇧 English", "lang:en");

const HELLO =
  "👋 <b>Здравствуйте!</b> Это бот бухгалтерии «Finpulse».\n" +
  "🇺🇿 <b>Assalomu alaykum!</b> Bu «Finpulse» buxgalteriya boti.\n" +
  "🇬🇧 <b>Hello!</b> This is the Finpulse accounting bot.\n\n" +
  "Выберите язык · Tilni tanlang · Choose a language 👇";

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

/* ---------------- Настройки бота (редактируются в CRM) ---------------- */
const DEFAULT_BOT_SETTINGS = { slaHours: 3, workStart: 9, workEnd: 16, tzOffset: 5 };
async function getBotSettings() {
  try {
    const s = await redis.get("bot:settings");
    if (s && typeof s === "object") return { ...DEFAULT_BOT_SETTINGS, ...s };
  } catch (e) { /* noop */ }
  return DEFAULT_BOT_SETTINGS;
}
function localHour(set) {
  const d = new Date(Date.now() + (set.tzOffset || 5) * 3600e3);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}
function inWorkHours(set) {
  const h = localHour(set);
  return h >= set.workStart && h < set.workEnd;
}

/* Дедлайн SLA с учётом окна приёма: если до конца рабочего дня времени
   не хватает, остаток переносится на завтра с открытия. */
function slaDeadline(set) {
  const now = localHour(set);
  const fmt = (hFloat) => {
    const h = Math.floor(hFloat) % 24;
    const m = Math.round((hFloat - Math.floor(hFloat)) * 60);
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  };
  const end = now + set.slaHours;
  if (end <= set.workEnd) return { time: fmt(end), tomorrow: false };
  const remaining = set.slaHours - Math.max(0, set.workEnd - now);
  const t = Math.min(set.workStart + remaining, set.workEnd);
  return { time: fmt(t), tomorrow: true };
}

/* ---------------- Категории услуг (редактируются в CRM) ---------------- */
const { DEFAULT_CATEGORIES } = require("../lib/knowledge.js");
async function getCategories() {
  try {
    const c = await redis.get("bot:categories");
    if (Array.isArray(c) && c.length) return c;
  } catch (e) { /* noop */ }
  return DEFAULT_CATEGORIES;
}
/* Подсказки из 1С по последней активности (ЭДО, документы) — оживёт после
   включения OData у провайдера: вернёт, например, «Подписать договор № 14». */
async function get1cSuggestions(company, catId) {
  return [];
}
function catsKb(cats) {
  const kb = new InlineKeyboard();
  cats.forEach((c, i) => { kb.text(c.name, "cat:" + i).row(); });
  return kb;
}
function subsKb(catIdx, subs) {
  const kb = new InlineKeyboard();
  subs.forEach((s2, i) => { kb.text(s2, "sub:" + catIdx + ":" + i).row(); });
  kb.text("✏️ Своя формулировка", "sub:" + catIdx + ":free").row();
  kb.text("⬅️ Назад", "cat:back");
  return kb;
}

/* ---------------- Должности и роли доверенных лиц ---------------- */
const DEFAULT_POSITIONS = ["👑 Директор", "💼 Владелец", "📚 Главный бухгалтер", "🧾 Бухгалтер", "📋 Менеджер"];
async function getPositions() {
  let list = DEFAULT_POSITIONS;
  try {
    const c = await redis.get("bot:positions");
    if (Array.isArray(c) && c.length) list = c.map((x) => String(x).slice(0, 40));
  } catch (e) { /* noop */ }
  return [...list, "✏️ Другое"];
}
function positionsKb(list) {
  const kb = new InlineKeyboard();
  list.forEach((p2, i) => { kb.text(p2, "pos:" + i); if (i % 2 === 1) kb.row(); });
  return kb;
}
/* Доверенное лицо: телефон совпадает с карточкой клиента (внесён бухгалтером)
   или первый зарегистрировавшийся по компании. Остальные ждут подтверждения. */
async function resolveClientRole(u, telegramId) {
  if (u.clientRole === "trusted") return "trusted";
  const normC = normCompany(u.company || "");
  if (u.phone) {
    try {
      const cid = await redis.get("clientphone:" + normPhone(u.phone));
      if (cid) {
        const c = await redis.get("client:" + cid);
        if (c && normCompany(c.company || "") === normC) {
          u.clientRole = "trusted";
          await redis.set("companyowner:" + normC, telegramId);
          return "trusted";
        }
      }
    } catch (e) { /* noop */ }
  }
  const owner = await redis.get("companyowner:" + normC);
  if (!owner) { await redis.set("companyowner:" + normC, telegramId); u.clientRole = "trusted"; return "trusted"; }
  if (String(owner) === String(telegramId)) { u.clientRole = "trusted"; return "trusted"; }
  u.clientRole = u.clientRole === "rejected" ? "rejected" : "pending";
  return u.clientRole;
}

/* Тексты новых сценариев */
const T2 = {
  ru: {
    chooseCategory: "Выберите услугу 👇",
    chooseSub: (cat) => `${cat}\nУточните, что нужно сделать:`,
    describeTask: (label) => `✅ ${label}\n\nОпишите детали (суммы, контрагент, сроки) и прикрепите файлы, если есть 📎`,
    freeText: "Опишите вашу задачу свободным текстом 👇",
    sla: (h, tm, tmr) => `⏱ Приняли! Проведём вашу операцию <b>в течение ${h} рабочих ч.</b>${tm ? (tmr ? ` — <b>завтра до ~${tm}</b>` : ` — до ~<b>${tm}</b>`) : ""}`,
    afterHours: (a, b) => `🕘 Приём заявок — с ${a}:00 до ${b}:00 (Ташкент). Сейчас нерабочее время.\n\nОтправить заявку на завтра или отменить?`,
    btnDefer: "📅 Отправить на завтра",
    deferOk: (a, h) => `📅 Заявка принята! Возьмём в работу <b>завтра с ${a}:00</b> и проведём в течение ${h} ч. — до ~${a + h}:00.`,
    askPositionTabs: "Кем вы работаете в компании? Выберите должность 👇",
    askPositionCustom: "Напишите вашу должность ✍️",
    pendingRole: "⏳ Ваш профиль ожидает подтверждения доверенным лицом компании. Отправлять заявки пока нельзя — мы уже отправили запрос, это быстро.",
    rejectedRole: "🚫 Доступ к отправке заявок для этого аккаунта не подтверждён. Свяжитесь с вашим руководителем или бухгалтером.",
    approveAsk: (name, pos, comp) => `🙋 ${name}${pos ? " (" + pos + ")" : ""} хочет отправлять заявки от компании «${comp}».\nРазрешить?`,
    btnAllow: "✅ Разрешить",
    btnDeny: "❌ Отклонить",
    approvedNote: "✅ Вам разрешили отправлять заявки. Добро пожаловать!",
    deniedNote: "🚫 Запрос на отправку заявок отклонён доверенным лицом компании.",
    approveDone: "Готово — доступ выдан.",
    denyDone: "Отклонено.",
  },
  uz: {
    chooseCategory: "Xizmatni tanlang 👇",
    chooseSub: (cat) => `${cat}\nAniqroq tanlang:`,
    describeTask: (label) => `✅ ${label}\n\nTafsilotlarni yozing (summa, kontragent, muddat) va fayl biriktiring 📎`,
    freeText: "Vazifangizni erkin matnda yozing 👇",
    sla: (h, tm, tmr) => `⏱ Qabul qilindi! Operatsiyangizni <b>${h} ish soati ichida</b> bajaramiz${tm ? (tmr ? ` — <b>ertaga ~${tm} gacha</b>` : ` — ~<b>${tm}</b> gacha`) : ""}.`,
    afterHours: (a, b) => `🕘 Arizalar ${a}:00–${b}:00 (Toshkent) qabul qilinadi. Hozir ish vaqti emas.\n\nErtaga yuboraylikmi yoki bekor qilasizmi?`,
    btnDefer: "📅 Ertagaga yuborish",
    deferOk: (a, h) => `📅 Ariza qabul qilindi! <b>Ertaga ${a}:00 dan</b> ishga olamiz va ${h} soat ichida bajaramiz — ~${a + h}:00 gacha.`,
    askPositionTabs: "Kompaniyada kim bo'lib ishlaysiz? Lavozimni tanlang 👇",
    askPositionCustom: "Lavozimingizni yozing ✍️",
    pendingRole: "⏳ Profilingiz kompaniya ishonchli vakili tasdig'ini kutmoqda. Hozircha ariza yuborib bo'lmaydi — so'rov yuborildi.",
    rejectedRole: "🚫 Bu akkauntga ariza yuborish tasdiqlanmagan. Rahbaringiz yoki buxgalter bilan bog'laning.",
    approveAsk: (name, pos, comp) => `🙋 ${name}${pos ? " (" + pos + ")" : ""} «${comp}» kompaniyasidan ariza yubormoqchi.\nRuxsat berasizmi?`,
    btnAllow: "✅ Ruxsat berish",
    btnDeny: "❌ Rad etish",
    approvedNote: "✅ Sizga ariza yuborishga ruxsat berildi. Xush kelibsiz!",
    deniedNote: "🚫 Ariza yuborish so'rovi rad etildi.",
    approveDone: "Tayyor — ruxsat berildi.",
    denyDone: "Rad etildi.",
  },
  en: {
    chooseCategory: "Choose a service 👇",
    chooseSub: (cat) => `${cat}\nBe more specific:`,
    describeTask: (label) => `✅ ${label}\n\nDescribe the details (amounts, counterparty, deadlines) and attach files 📎`,
    freeText: "Describe your task in free text 👇",
    sla: (h, tm, tmr) => `⏱ Got it! We'll process your operation <b>within ${h} working h</b>${tm ? (tmr ? ` — <b>tomorrow by ~${tm}</b>` : ` — by ~<b>${tm}</b>`) : ""}.`,
    afterHours: (a, b) => `🕘 Requests are accepted ${a}:00–${b}:00 (Tashkent). It's after hours now.\n\nSend it for tomorrow or cancel?`,
    btnDefer: "📅 Send for tomorrow",
    deferOk: (a, h) => `📅 Request accepted! We'll take it <b>tomorrow from ${a}:00</b> and process it within ${h} h — by ~${a + h}:00.`,
    askPositionTabs: "What's your position at the company? 👇",
    askPositionCustom: "Type your position ✍️",
    pendingRole: "⏳ Your profile is awaiting confirmation by the company's trusted person. You can't send requests yet — we've sent them a request.",
    rejectedRole: "🚫 Sending requests from this account wasn't confirmed. Contact your manager or accountant.",
    approveAsk: (name, pos, comp) => `🙋 ${name}${pos ? " (" + pos + ")" : ""} wants to send requests for "${comp}".\nAllow?`,
    btnAllow: "✅ Allow",
    btnDeny: "❌ Deny",
    approvedNote: "✅ You can now send requests. Welcome!",
    deniedNote: "🚫 Your request was denied by the company's trusted person.",
    approveDone: "Done — access granted.",
    denyDone: "Denied.",
  },
};
const t2of = (u) => T2[u && u.lang ? u.lang : "ru"] || T2.ru;

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
  try {
    await sendToGroup((gid) => bot.api.sendMessage(
      gid,
      "🆕 <b>Новый клиент в боте</b>\n" +
      "🏢 <b>" + escapeHtml(u.company) + "</b>\n\n" +
      "Компании нет в базе CRM — создайте карточку и назначьте ответственного. " +
      "Телефон клиента — в списке «Ожидают активации».",
      { parse_mode: "HTML" }
    ));
  } catch (e) { console.error("notify new company:", e); }
}

async function afterCompanySet(ctx, u) {
  const t = T[u.lang];
  if (!u.position) {
    u.state = "position";
    await setUser(ctx.from.id, u);
    return ctx.reply(t2of(u).askPositionTabs, { reply_markup: positionsKb(await getPositions()) });
  }
  u.state = u.phone ? "idle" : "phone";
  await setUser(ctx.from.id, u);
  if (u.state === "idle") return finishOnboarding(ctx, u);
  return ctx.reply(t.askPhone, { reply_markup: phoneKb(t) });
}

async function finishOnboarding(ctx, u) {
  const t = T[u.lang];
  await notifyNewCompany(u);
  const role = await resolveClientRole(u, ctx.from.id);
  const newPassword = await ensureClientCredentials(ctx, u);
  await upsertClient(u, ctx.from.id);
  await setUser(ctx.from.id, u);
  await ctx.reply(t.ready(u.company), { reply_markup: mainKb(u.lang) });
  if (role === "pending") { try { await ctx.reply(t2of(u).pendingRole); } catch (e) { /* noop */ } }
  if (newPassword) {
    await sendAndPinCreds(ctx, t.crmCreds(u.authPhone, newPassword));
  } else if (u.phone && !u.pwdHash) {
    await ctx.reply(t.crmPending);
  }
  return;
}

const STATUS_EMOJI = { new: "⚪️", in_progress: "🔵", done: "✅", cancelled: "🚫" };

/* Журнал событий для CRM (logs:telegram) */
async function logEvent(source, event, data) {
  try {
    await redis.lpush("logs:" + source, JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
    await redis.ltrim("logs:" + source, 0, 499);
  } catch (e) { console.error("log:", e); }
}

/* Заявка на ручную проверку доступа — видна в CRM (раздел «Клиенты») */
async function addAccessRequest(type, data) {
  try {
    const id = "ar_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await redis.lpush("access_requests", JSON.stringify({
      id, type, status: "pending", at: new Date().toISOString(), ...data,
    }));
    await redis.ltrim("access_requests", 0, 49);
    return id;
  } catch (e) { return null; }
}

/* Отправка длинного текста частями (в пределах лимита Telegram) */
async function sendLong(ctx, text, opts) {
  const LIMIT = 4000;
  if (text.length <= LIMIT) return ctx.reply(text, opts);
  let last;
  for (let i = 0; i < text.length; i += LIMIT) {
    const isLast = i + LIMIT >= text.length;
    last = await ctx.reply(text.slice(i, i + LIMIT), isLast ? opts : (opts && opts.parse_mode ? { parse_mode: opts.parse_mode } : undefined));
  }
  return last;
}

async function listTasks(ctx, u) {
  const t = T[u.lang];
  const nums = (await redis.lrange("utasks:" + ctx.from.id, 0, 19)) || [];
  if (!nums.length) return ctx.reply(t.noTasks, { reply_markup: mainKb(u.lang) });

  const active = [], history = [];
  const fetched = (await redis.mget(...nums.map((n) => taskKey(Number(n))))) || [];
  for (const task of fetched) {
    if (!task) continue;
    (task.status === "done" ? history : active).push(task);
  }
  if (!active.length && !history.length) return ctx.reply(t.noTasks, { reply_markup: mainKb(u.lang) });

  const block = (task) =>
    (STATUS_EMOJI[task.status] || "⚪️") + " <b>№" + task.num + "</b>" +
    (task.assignee ? " · 👩‍💼 " + escapeHtml(task.assignee) : "") +
    (task.files && task.files.length ? " · 📎" + task.files.length : "") +
    "\n" + escapeHtml(task.text || "");

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

  const withFiles = [...active, ...history].filter((x) => x.files && x.files.length).slice(0, 6);

  let opts = { reply_markup: mainKb(u.lang), parse_mode: "HTML" };
  if (history.length || withFiles.length) {
    const kb = new InlineKeyboard();
    history.slice(0, 5).forEach((task, i) => {
      kb.text("🔁 №" + task.num, "reuse:" + task.num);
      if (i % 3 === 2) kb.row();
    });
    if (history.length % 3 !== 0) kb.row();
    withFiles.forEach((task, i) => {
      kb.text("📎 №" + task.num, "files:" + task.num);
      if (i % 3 === 2) kb.row();
    });
    opts = { reply_markup: kb, parse_mode: "HTML" };
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

/* Когда группу апгрейдят до супергруппы, её chat_id меняется — сохранённый
   в redis "group" старый id перестаёт работать, и Telegram API отвечает
   ошибкой "group chat was upgraded to a supergroup chat" с правильным
   новым id в parameters.migrate_to_chat_id. Без этой обёртки такие ошибки
   либо проглатывались try/catch'ами (карточки задач переставали доходить
   до группы), либо всплывали как "Telegram отклонил файл". Она сама
   подхватывает актуальный id, обновляет его в redis при миграции и
   повторяет запрос один раз. Возвращает null, если группа вообще не
   привязана (/bind ещё не выполнялся). */
async function sendToGroup(fn) {
  const group = await redis.get("group");
  if (!group) return null;
  try {
    return await fn(group);
  } catch (e) {
    const newId = e && e.parameters && e.parameters.migrate_to_chat_id;
    if (newId) {
      await redis.set("group", newId);
      return await fn(newId);
    }
    throw e;
  }
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
  return ctx.reply(HELLO, { reply_markup: LANG_KB, parse_mode: "HTML" });
});

bot.command("lang", async (ctx) => {
  if (!isPrivate(ctx)) return;
  return ctx.reply(HELLO, { reply_markup: LANG_KB, parse_mode: "HTML" });
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
  if (!u || !u.lang) return ctx.reply(HELLO, { reply_markup: LANG_KB, parse_mode: "HTML" });
  u.state = "idle";
  u.draft = null;
  await setUser(ctx.from.id, u);
  return ctx.reply(T[u.lang].idleHint, { reply_markup: mainKb(u.lang) });
});

bot.command("tasks", async (ctx) => {
  if (!isPrivate(ctx)) return;
  const u = await getUser(ctx.from.id);
  if (!u || !u.lang) return ctx.reply(HELLO, { reply_markup: LANG_KB, parse_mode: "HTML" });
  return listTasks(ctx, u);
});

bot.command("company", async (ctx) => {
  if (!isPrivate(ctx)) return;
  const u = await getUser(ctx.from.id);
  if (!u || !u.lang) return ctx.reply(HELLO, { reply_markup: LANG_KB, parse_mode: "HTML" });
  u.state = "company";
  await setUser(ctx.from.id, u);
  return ctx.reply(T[u.lang].askCompany);
});

bot.command("password", async (ctx) => {
  if (!isPrivate(ctx)) return;
  const u = await getUser(ctx.from.id);
  if (!u || !u.lang) return ctx.reply(HELLO, { reply_markup: LANG_KB, parse_mode: "HTML" });
  if (!u.phone) return ctx.reply(T[u.lang].askPhone, { reply_markup: phoneKb(T[u.lang]) });
  const password = await issueClientPassword(ctx, u);
  await setUser(ctx.from.id, u);
  if (!password) {
    return ctx.reply(T[u.lang].crmPending);
  }
  return sendAndPinCreds(ctx, T[u.lang].crmCreds(u.authPhone, password));
});

/* Telegram сам присылает служебное сообщение с migrate_to_chat_id в СТАРЫЙ
   чат в момент апгрейда группы до супергруппы — ловим его и сразу
   обновляем сохранённый id, не дожидаясь первой упавшей отправки. */
bot.on("message:migrate_to_chat_id", async (ctx) => {
  const newId = ctx.message.migrate_to_chat_id;
  const current = await redis.get("group");
  if (newId && String(current) === String(ctx.chat.id)) {
    await redis.set("group", newId);
  }
});

/* ---------------- Команды: группа ---------------- */
bot.command("bind", async (ctx) => {
  if (!isGroup(ctx)) return;
  const code = (ctx.match || "").trim();
  if (!process.env.BIND_CODE || !timingSafeStringEqual(code, process.env.BIND_CODE)) {
    return ctx.reply("❌ Неверный код привязки. Используйте: /bind ВАШ_КОД");
  }
  await redis.set("group", ctx.chat.id);
  return ctx.reply(
    "✅ Группа привязана к Finpulse CRM!\n\nСюда будут приходить новые задачи клиентов. Отвечайте на карточку задачи — ответ уйдёт клиенту."
  );
});

/* ---------------- Выбор языка ---------------- */
/* Кнопка-вариант под уточняющим вопросом ИИ-бухгалтера в группе (см.
   askClarificationInGroup/buildAiqKeyboard в api/ai.js) — тот же эффект, что
   и текстовый реплай с названием варианта, но бухгалтеру не нужно печатать. */
bot.callbackQuery(/^aiqb:(.+)$/, async (ctx) => {
  const token = ctx.match[1];
  let rec = null;
  try { rec = await redis.get("aiqb:" + token); } catch (e) {}
  if (!rec || !rec.num) {
    await ctx.answerCallbackQuery("Этот вопрос уже обработан или устарел.").catch(() => {});
    return;
  }
  try { await redis.del("aiqb:" + token); } catch (e) {}
  await ctx.answerCallbackQuery("Принято ✅").catch(() => {});
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch (e) { /* сообщение могло уже смениться — не критично */ }
  await triggerAutoWork(Number(rec.num), String(rec.value || ""), { kind: rec.kind || "generic", suggestions: rec.suggestions || [] });
});

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
bot.callbackQuery(/^files:(\d+)$/, async (ctx) => {
  const u = await getUser(ctx.from.id);
  const task = await redis.get(taskKey(Number(ctx.match[1])));
  if (!task || task.client !== ctx.from.id) return ctx.answerCallbackQuery("✖️");
  if (!task.files || !task.files.length) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery("📎");
  for (const f of task.files) {
    await sendFileTo(ctx.from.id, f, `📎 к задаче №${task.num}`);
  }
});

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

/* Создание задачи из черновика (вызывается из submit и defer) */
async function createTaskFromDraft(ctx, u, deferred) {
  const t = T[u.lang];
  const t2 = t2of(u);
  const set = await getBotSettings();

  const n = await redis.incr("counter:task");
  const num = 100 + n;
  const task = {
    num,
    client: ctx.from.id,
    company: u.company,
    text: formatSumsInText(u.draft.text),
    category: u.draft.category || null,
    sub: u.draft.sub || null,
    files: u.draft.files || [],
    status: "new",
    assignee: null,
    deferred: !!deferred,
    createdAt: new Date().toISOString(),
  };

  /* Сохраняем задачу сразу — она не потеряется, даже если отправка в группу упадёт */
  await redis.set(taskKey(num), task);
  await redis.lpush("utasks:" + ctx.from.id, num);
  await redis.ltrim("utasks:" + ctx.from.id, 0, 19);
  await logEvent("telegram", "task_created", {
    num,
    company: task.company,
    category: task.category || null,
    from: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") + (ctx.from.username ? " @" + ctx.from.username : ""),
    files: task.files.length,
    deferred: !!deferred,
    text: task.text.slice(0, 120),
  });
  u.state = "idle";
  u.draft = null;
  await setUser(ctx.from.id, u);

  /* Подтверждение клиенту + ожидаемое время */
  await ctx.answerCallbackQuery("✅");
  const confirm = await ctx.reply(t.created(num).replace(`№${num}`, `<b>№${num}</b>`), { parse_mode: "HTML" });
  await redis.set(clientRouteKey(ctx.from.id, confirm.message_id), num);
  try {
    const dl = slaDeadline(set);
    await ctx.reply(deferred ? t2.deferOk(set.workStart, set.slaHours) : t2.sla(set.slaHours, dl.time, dl.tomorrow), { parse_mode: "HTML" });
  } catch (e) { /* noop */ }

  /* Карточка в группу бухгалтеров (без личных данных клиента) */
  try {
    const catLine = task.category ? `🗂 ${escapeHtml(task.category)}${task.sub ? " · " + escapeHtml(task.sub) : ""}\n` : "";
    const base =
      `🆕 <b>Задача №${num}</b> · ⚪️ Новая\n` +
      `🏢 <b>${escapeHtml(task.company || "—")}</b>\n` +
      catLine +
      `━━━━━━━━━━━━\n`;
    const tail =
      (task.files.length ? `\n\n📎 Вложений: ${task.files.length}` : "") +
      (deferred ? `\n⏸ <i>Получена вне часов приёма — в работу с ${set.workStart}:00</i>` : "") +
      `\n\n👉 <i>Исполнитель и статус — в CRM</i>`;
    const room = 3700 - base.length - tail.length;
    let body = escapeHtml(task.text);
    let rest = "";
    if (body.length > room) {
      rest = body.slice(room);
      body = "<b>" + body.slice(0, room) + "</b>… <i>(продолжение ⬇️)</i>";
    } else {
      body = "<b>" + body + "</b>";
    }
    const gm = await sendToGroup((gid) => bot.api.sendMessage(gid, base + body + tail, { parse_mode: "HTML" }));
    if (!gm) return; // группа не привязана — карточка некуда отправлять
    task.gmsg = gm.message_id;
    await redis.set(taskKey(num), task);
    await redis.set(groupRouteKey(gm.message_id), num);

    while (rest.length) {
      const chunk = rest.slice(0, 3900);
      rest = rest.slice(3900);
      const cm = await sendToGroup((gid) => bot.api.sendMessage(gid, "…" + chunk + (rest.length ? "…" : ""), {
        reply_to_message_id: gm.message_id,
      }));
      if (cm) await redis.set(groupRouteKey(cm.message_id), num);
    }

    for (const f of task.files) {
      const fm = await sendToGroup((gid) => sendFileTo(gid, f, `📎 к задаче №${num}`));
      if (fm) await redis.set(groupRouteKey(fm.message_id), num);
    }
  } catch (e) {
    console.error("group send:", e);
    await logEvent("telegram", "group_send_failed", { num, error: String(e).slice(0, 200) });
  }

  /* ---- AI-бухгалтер: полный разбор заявки + подсказка бухгалтерам в группу ---- */
  if (process.env.OPENAI_API_KEY) {
    try {
      const aiSet = (await redis.get("ai:settings")) || {};
      if (aiSet.classify !== false) {
        const { intakeTask, draftFromTask } = require("../lib/ai.js");
        const { buildClientContext, addMemory } = require("../lib/brain.js");
        const cats = await getCategories();
        const clientContext = await buildClientContext(redis, task.company);

        /* загрузка сотрудников для рекомендации исполнителя */
        let employees = [];
        try {
          const ids = (await redis.smembers("employees")) || [];
          const recs = ids.length ? await redis.mget(...ids.map((i) => "employee:" + i)) : [];
          const names = recs.filter((e) => e && e.active !== false).map((e) => e.name);
          if (names.length) {
            const cnt = {};
            const nMax = Number((await redis.get("counter:task")) || 0);
            const keys = [];
            for (let i = 100 + nMax; i > Math.max(100, 100 + nMax - 60); i--) keys.push(taskKey(i));
            const recent = keys.length ? await redis.mget(...keys) : [];
            for (const tk of recent) {
              if (tk && tk.assignee && (tk.status === "new" || tk.status === "in_progress")) {
                cnt[tk.assignee] = (cnt[tk.assignee] || 0) + 1;
              }
            }
            employees = names.map((nm) => ({ name: nm, activeTasks: cnt[nm] || 0 }));
          }
        } catch (e) { /* noop */ }

        const ai = await intakeTask({
          text: task.text,
          company: task.company,
          categories: cats,
          employees,
          today: new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10),
          context: clientContext,
          redis,
        });

        if (ai) {
          if (!task.category && ai.category) { task.category = ai.category; task.sub = ai.sub || null; }
          task.priority = ai.priority;
          if (ai.dueDate && !task.dueDate) task.dueDate = ai.dueDate;
          if (ai.assignee && !task.assignee && employees.some((e) => e.name === ai.assignee)) {
            task.assignee = ai.assignee;
            task.status = "in_progress";
          }
          task.aiIntake = { ...ai, at: new Date().toISOString() };
          if (ai.remember) { try { await addMemory(redis, task.company, ai.remember, "AI-intake"); } catch (e) { /* noop */ } }

          /* простая типовая задача → сразу готовим черновик операции */
          let draft = null;
          if (ai.complexity === "simple" && aiSet.drafts !== false) {
            try {
              let clientInfo = null;
              const cid = await redis.get("clientcompany:" + normCompany(task.company || ""));
              if (cid) clientInfo = await redis.get("client:" + cid);
              draft = await draftFromTask(task, clientInfo, { redis });
              if (draft) task.aiDraft = { ...draft, generatedAt: new Date().toISOString(), by: "AI-бухгалтер" };
            } catch (e) { /* noop */ }
          }

          await redis.set(taskKey(num), task);
          await logEvent("telegram", "task_ai_intake", {
            num, category: task.category || null, priority: ai.priority,
            complexity: ai.complexity, assignee: task.assignee || null, draft: !!draft,
          });

          /* подсказка бухгалтерам — ответом на карточку задачи */
          try {
            const e2 = escapeHtml;
            const lines = [
              `🤖 <b>AI-бухгалтер</b> · задача №${num}`,
              `🗂 ${e2(task.category || "категория не определена")}${task.sub ? " · " + e2(task.sub) : ""}`,
              `⚡ <b>Приоритет:</b> ${ai.priority} · <b>сложность:</b> ${ai.complexity === "simple" ? "простая" : ai.complexity === "complex" ? "сложная" : "средняя"}`,
            ];
            if (task.dueDate) lines.push(`📅 <b>Срок:</b> ${task.dueDate}`);
            if (task.assignee) lines.push(`👤 <b>Исполнитель:</b> ${e2(task.assignee)} (наименее загружен) — взята в работу`);
            if (ai.operation1c) lines.push(`🧾 <b>Операция 1С:</b> ${e2(ai.operation1c)}`);
            if (!ai.relevant) lines.push("⚠️ <i>Похоже, заявка не относится к бухгалтерии — уточните у клиента.</i>");
            if (ai.missing.length) lines.push(`❗ <b>Не хватает:</b> ${e2(ai.missing.join(", "))}`);
            if (draft) lines.push("📝 <b>Черновик операции готов</b> — проверьте в CRM.");
            if (ai.hint) lines.push(`\n💡 ${e2(ai.hint)}`);
            const reply = task.gmsg ? { reply_to_message_id: task.gmsg } : {};
            const hm = await sendToGroup((gid) => bot.api.sendMessage(gid, lines.join("\n"), { ...reply, parse_mode: "HTML" }));
            if (hm) await redis.set(groupRouteKey(hm.message_id), num);
          } catch (e) { /* noop */ }
        }
      }
    } catch (e) {
      console.error("ai intake:", e);
      await logEvent("telegram", "ai_intake_failed", { num, error: String(e).slice(0, 150) });
    }
  }

  /* Автономный ИИ-бухгалтер: берёт задачу в работу сам, если тублер
     ai:settings.autoWork включён (иначе /api/ai молча выходит).
     await — чтобы serverless-контейнер не заморозился раньше времени. */
  await triggerAutoWork(num);
}

/* Запрос подтверждения доверенному лицу + заявка в CRM */
async function requestMemberApproval(ctx, u) {
  const t2 = t2of(u);
  const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") + (ctx.from.username ? " @" + ctx.from.username : "");
  const normC = normCompany(u.company || "");
  if (u.approvalRequested) return ctx.reply(t2.pendingRole);
  u.approvalRequested = true;
  await setUser(ctx.from.id, u);
  try {
    const id = "ar_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await redis.lpush("access_requests", JSON.stringify({
      id, type: "member_approve", status: "pending", at: new Date().toISOString(),
      company: u.company, tgName: name, telegramId: ctx.from.id, position: u.position || null,
    }));
    await redis.ltrim("access_requests", 0, 49);
  } catch (e) { /* noop */ }
  try {
    const owner = await redis.get("companyowner:" + normC);
    if (owner) {
      const ownerU = await getUser(owner);
      const to2 = t2of(ownerU || u);
      const kb = new InlineKeyboard()
        .text(to2.btnAllow, `memb:yes:${ctx.from.id}`)
        .text(to2.btnDeny, `memb:no:${ctx.from.id}`);
      await bot.api.sendMessage(Number(owner), to2.approveAsk(name, u.position, u.company), { reply_markup: kb });
    }
  } catch (e) { /* noop */ }
  try {
    await sendToGroup((gid) => bot.api.sendMessage(gid,
      `🙋 <b>Запрос доступа</b>\n«<b>${escapeHtml(u.company)}</b>»: ${escapeHtml(name)}${u.position ? " · " + escapeHtml(u.position) : ""} просит право отправлять заявки.\n👉 <i>Подтвердить: Telegram-кнопка у доверенного лица или CRM → Клиенты</i>.`, { parse_mode: "HTML" }));
  } catch (e) { /* noop */ }
  return ctx.reply(t2.pendingRole);
}

bot.callbackQuery("submit", async (ctx) => {
  const u = await getUser(ctx.from.id);
  if (!u || !u.draft) return ctx.answerCallbackQuery();
  const t = T[u.lang];
  const t2 = t2of(u);
  if (!u.draft.text || !u.draft.text.trim()) {
    await ctx.answerCallbackQuery();
    return ctx.reply(t.needText);
  }

  /* Только доверенное лицо может отправлять заявки */
  const role = u.clientRole === "trusted-member" ? "trusted" : await resolveClientRole(u, ctx.from.id);
  if (role === "rejected") { await ctx.answerCallbackQuery(); return ctx.reply(t2.rejectedRole); }
  if (role === "pending") { await ctx.answerCallbackQuery(); return requestMemberApproval(ctx, u); }

  /* Часы приёма заявок */
  const set = await getBotSettings();
  if (!inWorkHours(set)) {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard().text(t2.btnDefer, "defer").text(t.btnCancel, "cancel");
    return ctx.reply(t2.afterHours(set.workStart, set.workEnd), { reply_markup: kb });
  }

  return createTaskFromDraft(ctx, u, false);
});

bot.callbackQuery("defer", async (ctx) => {
  const u = await getUser(ctx.from.id);
  if (!u || !u.draft || !u.draft.text) return ctx.answerCallbackQuery();
  const role = u.clientRole === "trusted-member" ? "trusted" : await resolveClientRole(u, ctx.from.id);
  if (role !== "trusted") { await ctx.answerCallbackQuery(); return requestMemberApproval(ctx, u); }
  return createTaskFromDraft(ctx, u, true);
});

/* Разрешение/отклонение сотрудника доверенным лицом */
bot.callbackQuery(/^memb:(yes|no):(\d+)$/, async (ctx) => {
  const owner = await getUser(ctx.from.id);
  if (!owner || owner.clientRole !== "trusted") return ctx.answerCallbackQuery("⛔");
  const targetId = Number(ctx.match[2]);
  const target = await getUser(targetId);
  if (!target) return ctx.answerCallbackQuery("✖️");
  if (normCompany(target.company || "") !== normCompany(owner.company || "")) return ctx.answerCallbackQuery("⛔");
  const allow = ctx.match[1] === "yes";
  target.clientRole = allow ? "trusted-member" : "rejected";
  target.approvalRequested = false;
  await setUser(targetId, target);
  await logEvent("telegram", allow ? "member_approved" : "member_rejected", {
    company: target.company, telegramId: targetId, by: "trusted:" + ctx.from.id,
  });
  const to2 = t2of(owner);
  await ctx.answerCallbackQuery(allow ? to2.approveDone : to2.denyDone);
  try { await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }); } catch (e) { /* noop */ }
  try { await bot.api.sendMessage(targetId, allow ? t2of(target).approvedNote : t2of(target).deniedNote); } catch (e) { /* noop */ }
});

/* ---------------- Категории услуг ---------------- */
bot.callbackQuery(/^cat:(back|\d+)$/, async (ctx) => {
  const u = await getUser(ctx.from.id);
  if (!u || !u.lang) return ctx.answerCallbackQuery();
  const t2 = t2of(u);
  const cats = await getCategories();
  if (ctx.match[1] === "back") {
    await ctx.answerCallbackQuery();
    try { return ctx.editMessageText(t2.chooseCategory, { reply_markup: catsKb(cats) }); }
    catch (e) { return ctx.reply(t2.chooseCategory, { reply_markup: catsKb(cats) }); }
  }
  const idx = Number(ctx.match[1]);
  const cat = cats[idx];
  if (!cat) return ctx.answerCallbackQuery("✖️");
  await ctx.answerCallbackQuery();
  const catName = String(cat.name).replace(/^[^\wа-яА-ЯёЁ]+\s*/, "");
  const suggestions = await get1cSuggestions(u.company, cat.id);
  const subs = [...suggestions, ...(cat.subs || [])].slice(0, 10);
  if (!subs.length) {
    u.state = "draft";
    u.draft = { text: "", files: [], category: catName, sub: null };
    await setUser(ctx.from.id, u);
    try { return ctx.editMessageText(t2.describeTask(cat.name)); }
    catch (e) { return ctx.reply(t2.describeTask(cat.name)); }
  }
  u.pendingCat = idx;
  await setUser(ctx.from.id, u);
  try { return ctx.editMessageText(t2.chooseSub(cat.name), { reply_markup: subsKb(idx, subs) }); }
  catch (e) { return ctx.reply(t2.chooseSub(cat.name), { reply_markup: subsKb(idx, subs) }); }
});

bot.callbackQuery(/^sub:(\d+):(free|\d+)$/, async (ctx) => {
  const u = await getUser(ctx.from.id);
  if (!u || !u.lang) return ctx.answerCallbackQuery();
  const t2 = t2of(u);
  const cats = await getCategories();
  const cat = cats[Number(ctx.match[1])];
  if (!cat) return ctx.answerCallbackQuery("✖️");
  const catName = String(cat.name).replace(/^[^\wа-яА-ЯёЁ]+\s*/, "");
  const suggestions = await get1cSuggestions(u.company, cat.id);
  const subs = [...suggestions, ...(cat.subs || [])].slice(0, 10);
  const sub = ctx.match[2] === "free" ? null : subs[Number(ctx.match[2])] || null;
  u.state = "draft";
  u.draft = { text: sub ? sub : "", files: [], category: catName, sub };
  delete u.pendingCat;
  await setUser(ctx.from.id, u);
  await ctx.answerCallbackQuery();
  const label = sub ? cat.name + " → " + sub : cat.name;
  try { return ctx.editMessageText(t2.describeTask(label)); }
  catch (e) { return ctx.reply(t2.describeTask(label)); }
});

/* Выбор должности табами при регистрации */
bot.callbackQuery(/^pos:(\d+)$/, async (ctx) => {
  const u = await getUser(ctx.from.id);
  if (!u || u.state !== "position") return ctx.answerCallbackQuery();
  const t2 = t2of(u);
  const idx = Number(ctx.match[1]);
  await ctx.answerCallbackQuery();
  const positions = await getPositions();
  if (idx >= positions.length - 1) {
    /* «Другое» — вводит текстом, state остаётся position */
    return ctx.reply(t2.askPositionCustom);
  }
  u.position = positions[idx].replace(/^[^\wа-яА-ЯёЁ]+\s*/, "");
  u.state = u.phone ? "idle" : "phone";
  await setUser(ctx.from.id, u);
  try { await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }); } catch (e) { /* noop */ }
  if (u.state === "idle") return finishOnboarding(ctx, u);
  return ctx.reply(T[u.lang].askPhone, { reply_markup: phoneKb(T[u.lang]) });
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

    /* --- Ответ бухгалтера на уточняющий вопрос ИИ-бухгалтера (reply на
       сообщение вида "🤖 Задача №N — нужна ваша помощь") --- НЕ пересылаем
       клиенту, а скармливаем текст обратно в автономный конвейер ИИ,
       чтобы он продолжил задачу с учётом уточнения. */
    const aiq = await redis.get("aiq:" + msg.reply_to_message.message_id);
    if (aiq && aiq.num) {
      const replyText = (msg.text || msg.caption || "").trim();
      if (!replyText) {
        return ctx.reply("Пожалуйста, ответьте текстом на вопрос ИИ-бухгалтера.", { reply_to_message_id: msg.message_id }).catch(() => {});
      }
      try { await redis.del("aiq:" + msg.reply_to_message.message_id); } catch (e) {}
      await triggerAutoWork(Number(aiq.num), replyText, { kind: aiq.kind || "generic", suggestions: aiq.suggestions || [] });
      return;
    }

    const num = await redis.get(groupRouteKey(msg.reply_to_message.message_id));
    if (!num) return;
    const task = await redis.get(taskKey(Number(num)));
    if (!task) return;

    /* Бухгалтер прикрепил файл реплаем на карточку задачи — сохраняем его
       в task.files, чтобы он тоже появился во вложениях в CRM (та же
       логика, что и для вложений, добавленных через CRM/при создании). */
    const bfile = extractFile(msg);
    let bFileIdx = null;
    if (bfile) {
      task.files = Array.isArray(task.files) ? task.files : [];
      task.files.push(bfile);
      bFileIdx = task.files.length - 1;
      task.updatedAt = new Date().toISOString();
      await logEvent("telegram", "task_file_attached", { num: task.num, by: "accountant" });
    }

    /* Текст/подпись реплая тоже сохраняем в task.thread — это и есть лента
       чата задачи, которую видно в CRM (полноценный двусторонний чат). */
    const bText = (msg.text || msg.caption || "").trim();
    if (bText || bFileIdx !== null) {
      const byName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || "Бухгалтер";
      task.thread = Array.isArray(task.thread) ? task.thread : [];
      task.thread.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: new Date().toISOString(),
        from: "staff",
        by: byName,
        text: bText || null,
        fileIndex: bFileIdx,
      });
      if (task.thread.length > 200) task.thread = task.thread.slice(-200);
    }
    if (bfile || bText) {
      await redis.set(taskKey(Number(num)), task);
    }

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
    return ctx.reply(HELLO, { reply_markup: LANG_KB, parse_mode: "HTML" });
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
        const cats = await getCategories();
        return ctx.reply(t2of(u).chooseCategory, { reply_markup: catsKb(cats) });
      }
      if (plain === M.myTasks) return listTasks(ctx, u);
      if (plain === M.lang) return ctx.reply(HELLO, { reply_markup: LANG_KB, parse_mode: "HTML" });
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
      const groupSet = await redis.get("group");
      if (task && groupSet) {
        /* Клиент прикрепил файл реплаем на свою задачу — сохраняем в
           task.files, чтобы вложение появилось и в CRM. */
        const cfile = extractFile(msg);
        let cFileIdx = null;
        if (cfile) {
          task.files = Array.isArray(task.files) ? task.files : [];
          task.files.push(cfile);
          cFileIdx = task.files.length - 1;
          task.updatedAt = new Date().toISOString();
          await logEvent("telegram", "task_file_attached", { num: task.num, by: "client" });
        }

        /* Текст/подпись реплая клиента тоже сохраняем в task.thread — та
           же лента чата, что видна в CRM. */
        const cText = (msg.text || msg.caption || "").trim();
        if (cText || cFileIdx !== null) {
          task.thread = Array.isArray(task.thread) ? task.thread : [];
          task.thread.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            at: new Date().toISOString(),
            from: "client",
            by: task.company || "Клиент",
            text: cText || null,
            fileIndex: cFileIdx,
          });
          if (task.thread.length > 200) task.thread = task.thread.slice(-200);
        }
        if (cfile || cText) {
          await redis.set(taskKey(Number(num)), task);
        }

        const opts = task.gmsg ? { reply_to_message_id: task.gmsg } : {};
        // "Обращение клиента из Telegram" — если выключено, не шлём отдельный
        // заголовок-уведомление "Клиент по задаче №N" (само сообщение клиента
        // всё равно копируется в группу ниже — это нужно для ленты чата).
        let ns = {};
        try { ns = (await redis.get("notif:settings")) || {}; } catch (e) {}
        if (ns.clientMessage !== false) {
          const label = await sendToGroup((gid) => bot.api.sendMessage(
            gid,
            `💬 <b>Клиент по задаче №${task.num}</b> (${escapeHtml(task.company || "")}):`,
            { ...opts, parse_mode: "HTML" }
          ));
          if (label) await redis.set(groupRouteKey(label.message_id), task.num);
        }
        const copied = await sendToGroup((gid) => bot.api.copyMessage(gid, ctx.chat.id, msg.message_id));
        if (copied) await redis.set(groupRouteKey(copied.message_id), task.num);
        return ctx.reply(t.replyRouted(task.num));
      }
    }
  }

  /* Любое сообщение вне черновика → сначала выбор категории услуги.
     Свободный текст принимается только внутри черновика (после выбора
     категории; для произвольных задач есть категория «Другое»). */
  if (u.state !== "draft") {
    const cats = await getCategories();
    return ctx.reply(t2of(u).chooseCategory, { reply_markup: catsKb(cats) });
  }

  const text = (msg.text || msg.caption || "").trim();
  const file = extractFile(msg);
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
    if (q.setup && process.env.BIND_CODE && timingSafeStringEqual(q.setup, process.env.BIND_CODE)) {
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
