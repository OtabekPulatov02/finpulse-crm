/* ============================================================
   Finpulse CRM — Telegram-бот (Vercel Serverless + Upstash Redis)

   Клиент: /start → язык (ру/узб/англ) → название компании →
   пишет задачу как обычному бухгалтеру (текст + файлы) →
   одна кнопка «Отправить» → задача уходит в группу бухгалтеров.

   Группа: карточка задачи БЕЗ личных данных клиента,
   кнопки «Взять в работу» / «Выполнена»,
   ответы на карточку пересылаются клиенту и обратно.
   ============================================================ */

const { Bot, webhookCallback, InlineKeyboard } = require("grammy");
const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

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
    myTasksTitle: "📋 Ваши последние задачи:",
    noTasks: "У вас пока нет задач. Просто напишите, что нужно сделать 👇",
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
    myTasksTitle: "📋 So'nggi vazifalaringiz:",
    noTasks: "Hozircha vazifalar yo'q. Nima qilish kerakligini yozing 👇",
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
    myTasksTitle: "📋 Your recent tasks:",
    noTasks: "No tasks yet. Just write what needs to be done 👇",
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

const STATUS_EMOJI = { new: "⚪️", in_progress: "🔵", done: "🟢" };

async function listTasks(ctx, u) {
  const t = T[u.lang];
  const nums = (await redis.lrange("utasks:" + ctx.from.id, 0, 4)) || [];
  if (!nums.length) return ctx.reply(t.noTasks, { reply_markup: mainKb(u.lang) });
  const lines = [t.myTasksTitle];
  for (const n of nums) {
    const task = await redis.get(taskKey(Number(n)));
    if (!task) continue;
    let text = (task.text || "").split("\n")[0];
    if (text.length > 48) text = text.slice(0, 48) + "…";
    lines.push((STATUS_EMOJI[task.status] || "⚪️") + " №" + task.num + " · " + text + (task.assignee ? " · 👩‍💼 " + task.assignee : ""));
  }
  return ctx.reply(lines.join("\n"), { reply_markup: mainKb(u.lang) });
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
  return ctx.reply(T[u?.lang || "ru"].help);
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
    text: u.draft.text.slice(0, 3500),
    files: u.draft.files || [],
    status: "new",
    assignee: null,
    createdAt: new Date().toISOString(),
  };

  /* Подтверждение клиенту */
  await ctx.answerCallbackQuery("✅");
  const confirm = await ctx.reply(t.created(num));
  await redis.set(clientRouteKey(ctx.from.id, confirm.message_id), num);

  /* Карточка в группу бухгалтеров (без личных данных клиента) */
  const group = await redis.get("group");
  if (group) {
    const header =
      `🆕 Задача №${num}\n` +
      `🏢 Компания: ${task.company}\n` +
      `——————————\n` +
      `${task.text}\n` +
      (task.files.length ? `\n📎 Вложений: ${task.files.length}` : "") +
      `\n\n⚪️ Статус: Новая`;
    const kb = new InlineKeyboard()
      .text("🙋 Взять в работу", `take:${num}`)
      .text("✅ Выполнена", `done:${num}`);
    const gm = await bot.api.sendMessage(group, header, { reply_markup: kb });
    task.gmsg = gm.message_id;
    await redis.set(groupRouteKey(gm.message_id), num);

    for (const f of task.files) {
      const fm = await sendFileTo(group, f, `📎 к задаче №${num}`);
      if (fm) await redis.set(groupRouteKey(fm.message_id), num);
    }
  }

  await redis.set(taskKey(num), task);
  await redis.lpush("utasks:" + ctx.from.id, num);
  await redis.ltrim("utasks:" + ctx.from.id, 0, 9);
  u.state = "idle";
  u.draft = null;
  await setUser(ctx.from.id, u);
});

/* ---------------- Кнопки в группе ---------------- */
bot.callbackQuery(/^take:(\d+)$/, async (ctx) => {
  const num = Number(ctx.match[1]);
  const task = await redis.get(taskKey(num));
  if (!task) return ctx.answerCallbackQuery("Задача не найдена");
  const name =
    [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || "бухгалтер";
  task.status = "in_progress";
  task.assignee = name;
  await redis.set(taskKey(num), task);

  const header =
    `🆕 Задача №${num}\n` +
    `🏢 Компания: ${task.company}\n` +
    `——————————\n` +
    `${task.text}\n` +
    (task.files.length ? `\n📎 Вложений: ${task.files.length}` : "") +
    `\n\n🔵 Статус: В работе · 👩‍💼 ${name}`;
  const kb = new InlineKeyboard().text("✅ Выполнена", `done:${num}`);
  try {
    await ctx.editMessageText(header, { reply_markup: kb });
  } catch (e) {}
  await ctx.answerCallbackQuery(`Задача №${num} на вас`);

  const clientLang = (await getUser(task.client))?.lang || "ru";
  await bot.api.sendMessage(task.client, T[clientLang].assigned(num, name));
});

bot.callbackQuery(/^done:(\d+)$/, async (ctx) => {
  const num = Number(ctx.match[1]);
  const task = await redis.get(taskKey(num));
  if (!task) return ctx.answerCallbackQuery("Задача не найдена");
  task.status = "done";
  await redis.set(taskKey(num), task);

  const header =
    `🆕 Задача №${num}\n` +
    `🏢 Компания: ${task.company}\n` +
    `——————————\n` +
    `${task.text}\n` +
    (task.files.length ? `\n📎 Вложений: ${task.files.length}` : "") +
    `\n\n🟢 Статус: Выполнена${task.assignee ? ` · 👩‍💼 ${task.assignee}` : ""}`;
  try {
    await ctx.editMessageText(header);
  } catch (e) {}
  await ctx.answerCallbackQuery(`Задача №${num} закрыта`);

  const clientLang = (await getUser(task.client))?.lang || "ru";
  await bot.api.sendMessage(task.client, T[clientLang].done(num));
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

  /* Онбординг: название компании */
  if (u.state === "company") {
    const name = (msg.text || msg.caption || "").trim();
    if (!name) return ctx.reply(t.askCompany);
    u.company = name.slice(0, 120);
    u.state = "idle";
    await setUser(ctx.from.id, u);
    return ctx.reply(t.ready(u.company), { reply_markup: mainKb(u.lang) });
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
      if (plain === M.help) return ctx.reply(t.help, { reply_markup: mainKb(u.lang) });
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
