/* ============================================================
   Finpulse CRM — calendar.js
   Календарь налогов, отчётов и обязательных платежей (демо).
   Данные демонстрационные, хранятся в памяти страницы.
   ============================================================ */

(function () {
  "use strict";

  /* ---------- Демо-данные ---------- */
  // type: tax — налоги/отчёты, pay — платежи фирм, task — дедлайны задач
  var EVENTS = [];

  function seed() {
    var y = 2026;
    // Налоги и отчёты (ежемесячные, июнь–октябрь)
    for (var m = 5; m <= 9; m++) {
      EVENTS.push(ev(y, m, 12, "tax", "НДФЛ и соцвзносы с зарплаты", "Все клиенты", "Ежемесячно", 3));
      EVENTS.push(ev(y, m, 20, "tax", "Декларация и оплата НДС", "Клиенты на ОСНО/НДС", "Ежемесячно", 3));
      EVENTS.push(ev(y, m, 25, "tax", "Авансовый платёж по УСН", "Клиенты на УСН", "Ежеквартально", 7));
      EVENTS.push(ev(y, m, 28, "tax", "Отчёт в статистику", "ООО «ТехноСфера»", "Ежемесячно", 1));
    }
    // Квартальные
    EVENTS.push(ev(y, 6, 27, "tax", "6-НДФЛ за полугодие", "Все клиенты", "Ежеквартально", 7));
    EVENTS.push(ev(y, 6, 30, "tax", "Отчётность по страховым взносам", "Все клиенты", "Ежеквартально", 7));

    // Обязательные платежи фирм (ежемесячные)
    for (var m2 = 5; m2 <= 9; m2++) {
      EVENTS.push(ev(y, m2, 5, "pay", "Аренда офиса — 12 000 000 сум", "ООО «ТехноСфера»", "Ежемесячно", 3));
      EVENTS.push(ev(y, m2, 10, "pay", "Интернет и связь — 850 000 сум", "ООО «ТехноСфера»", "Ежемесячно", 1));
      EVENTS.push(ev(y, m2, 15, "pay", "Аренда склада — 26 000 000 сум", "ООО «Логистик Групп»", "Ежемесячно", 3));
      EVENTS.push(ev(y, m2, 25, "pay", "Лизинг оборудования — 9 500 000 сум", "ООО «МедФарм»", "Ежемесячно", 3));
    }
    EVENTS.push(ev(y, 7, 1, "pay", "Страховка автопарка — 34 000 000 сум", "ООО «Логистик Групп»", "Ежегодно", 7));

    // Дедлайны задач из трекера
    EVENTS.push(ev(y, 6, 10, "task", "Ответ на требование ИФНС № 14-08/2214", "ООО «СтройГарант»", "", 1));
    EVENTS.push(ev(y, 6, 18, "task", "Сверка расчётов с ИФНС", "ООО «ТехноСфера»", "", 1));
    EVENTS.push(ev(y, 6, 25, "task", "Декларация по НДС за II квартал (№ 1247)", "ООО «ТехноСфера»", "", 3));
    EVENTS.push(ev(y, 6, 31, "task", "Книга доходов и расходов за полугодие", "ООО «МедФарм»", "", 3));
  }

  function ev(y, m, d, type, title, company, repeat, remind) {
    return { date: new Date(y, m, d), type: type, title: title, company: company, repeat: repeat, remind: remind };
  }

  /* ---------- Состояние ---------- */
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var cur = new Date(today.getFullYear(), today.getMonth(), 1);
  var typeFilter = "all";

  var MONTHS = ["январь","февраль","март","апрель","май","июнь","июль","август","сентябрь","октябрь","ноябрь","декабрь"];
  var MONTHS_G = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
  var DOW = ["Пн","Вт","Ср","Чт","Пт","Сб","Вс"];
  var DOW_FULL = ["понедельник","вторник","среда","четверг","пятница","суббота","воскресенье"];

  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function fmt(d) { return d.getDate() + " " + MONTHS_G[d.getMonth()]; }
  function daysDiff(d) { return Math.round((d - today) / 86400000); }

  function visible(e) { return typeFilter === "all" || e.type === typeFilter; }
  function eventsOn(d) {
    return EVENTS.filter(function (e) { return sameDay(e.date, d) && visible(e); });
  }

  /* ---------- Сетка месяца ---------- */
  function render() {
    document.getElementById("cal-title").textContent = MONTHS[cur.getMonth()] + " " + cur.getFullYear();
    var grid = document.getElementById("cal-grid");
    grid.innerHTML = "";

    DOW.forEach(function (n, i) {
      var el = document.createElement("div");
      el.className = "cal-dow" + (i > 4 ? " weekend" : "");
      el.textContent = n;
      grid.appendChild(el);
    });

    var first = new Date(cur.getFullYear(), cur.getMonth(), 1);
    var start = new Date(first);
    start.setDate(first.getDate() - ((first.getDay() + 6) % 7)); // с понедельника

    for (var i = 0; i < 42; i++) {
      var d = new Date(start);
      d.setDate(start.getDate() + i);
      var cell = document.createElement("div");
      var dow = (d.getDay() + 6) % 7;
      cell.className = "cal-cell" +
        (d.getMonth() !== cur.getMonth() ? " other" : "") +
        (sameDay(d, today) ? " today" : "") +
        (dow > 4 ? " weekend" : "");

      var num = document.createElement("div");
      num.className = "cal-daynum";
      num.textContent = d.getDate();
      cell.appendChild(num);

      var evs = eventsOn(d);
      evs.slice(0, 3).forEach(function (e) {
        var p = document.createElement("div");
        p.className = "cal-pill " + e.type + (e.done ? " done" : "");
        p.textContent = e.title;
        p.title = e.title + " · " + e.company;
        cell.appendChild(p);
      });
      if (evs.length > 3) {
        var more = document.createElement("div");
        more.className = "cal-more";
        more.textContent = "ещё " + (evs.length - 3);
        cell.appendChild(more);
      }

      (function (dd) {
        cell.addEventListener("click", function () { openDay(dd); });
      })(new Date(d));

      grid.appendChild(cell);
    }

    renderUpcoming();
  }

  /* ---------- Ближайшие 14 дней ---------- */
  function renderUpcoming() {
    var box = document.getElementById("cal-upcoming");
    box.innerHTML = "";
    var list = EVENTS
      .filter(function (e) {
        var dd = daysDiff(e.date);
        return dd >= 0 && dd <= 14 && visible(e) && !e.done;
      })
      .sort(function (a, b) { return a.date - b.date; })
      .slice(0, 8);

    if (!list.length) {
      box.innerHTML = '<div class="empty-state" style="padding:28px 16px;"><div class="es-icon"><i data-lucide="calendar-check" class="icon"></i></div><h3>Всё спокойно</h3><p>В ближайшие две недели сроков нет.</p></div>';
      if (window.lucide) lucide.createIcons();
      return;
    }

    var ico = { tax: ["receipt", "ic-purple"], pay: ["credit-card", "ic-blue"], task: ["list-todo", "ic-yellow"] };
    list.forEach(function (e) {
      var dd = daysDiff(e.date);
      var when = dd === 0 ? "сегодня" : dd === 1 ? "завтра" : "через " + dd + " дн.";
      var cls = dd === 0 ? "today" : dd <= 3 ? "soon" : "later";
      var el = document.createElement("div");
      el.className = "up-item";
      el.innerHTML =
        '<div class="up-ico ' + ico[e.type][1] + '"><i data-lucide="' + ico[e.type][0] + '" class="icon"></i></div>' +
        '<div style="min-width:0;">' +
          '<div class="up-title">' + e.title + "</div>" +
          '<div class="up-sub">' + e.company + " · " + fmt(e.date) + (e.repeat ? " · 🔁 " + e.repeat.toLowerCase() : "") + "</div>" +
          '<div class="up-bot"><i data-lucide="send" class="icon"></i>бот уведомит группу за ' + e.remind + " дн.</div>" +
        "</div>" +
        '<span class="up-when ' + cls + '">' + when + "</span>";
      box.appendChild(el);
    });
    if (window.lucide) lucide.createIcons();
  }

  /* ---------- Drawer: события дня ---------- */
  var selectedDay = null;

  function openDay(d) {
    selectedDay = new Date(d);
    var evs = eventsOn(d);
    document.getElementById("day-title").textContent = fmt(d) + ", " + DOW_FULL[(d.getDay() + 6) % 7];
    var cnt = document.getElementById("day-count");
    if (cnt) cnt.textContent = evs.length ? "Событий: " + evs.length : "Свободный день";
    var box = document.getElementById("day-events");
    box.innerHTML = "";

    if (!evs.length) {
      box.innerHTML = '<div class="empty-state" style="padding:36px 16px;"><div class="es-icon"><i data-lucide="calendar-plus" class="icon"></i></div><h3>На этот день ничего нет</h3><p>Нажмите кнопку ниже, чтобы добавить напоминание.</p></div>';
    }

    var ico = { tax: ["receipt", "ic-purple"], pay: ["credit-card", "ic-blue"], task: ["list-todo", "ic-yellow"] };
    var names = { tax: "Налог / отчёт", pay: "Платёж", task: "Задача" };
    evs.forEach(function (e) {
      var el = document.createElement("div");
      el.className = "day-event";
      el.innerHTML =
        '<div class="up-ico ' + ico[e.type][1] + '"><i data-lucide="' + ico[e.type][0] + '" class="icon"></i></div>' +
        '<div style="min-width:0;">' +
          '<div class="up-title"' + (e.done ? ' style="text-decoration:line-through;opacity:.6;"' : "") + ">" + e.title + "</div>" +
          '<div class="up-sub">' + names[e.type] + " · " + e.company + (e.repeat ? " · 🔁 " + e.repeat.toLowerCase() : "") + "</div>" +
        "</div>" +
        '<div class="de-actions">' +
          (e.type !== "task" && !e.done
            ? '<button class="btn btn-secondary btn-sm" data-act="task"><i data-lucide="list-plus" class="icon"></i>В задачи</button>' +
              '<button class="btn btn-secondary btn-sm" data-act="done"><i data-lucide="check" class="icon"></i>Готово</button>'
            : "") +
        "</div>";
      var btns = el.querySelectorAll("[data-act]");
      btns.forEach(function (b) {
        b.addEventListener("click", function (evn) {
          evn.stopPropagation();
          if (b.getAttribute("data-act") === "done") {
            e.done = true;
            render();
            openDay(d);
            window.showToast && showToast("success", "Отмечено выполненным", e.title);
          } else {
            window.showToast && showToast("success", "Задача создана", "«" + e.title + "» добавлена в трекер и назначена ответственному.");
          }
        });
      });
      box.appendChild(el);
    });

    if (window.lucide) lucide.createIcons();
    document.getElementById("drawer-day").classList.add("open");
  }

  /* ---------- Модалка нового напоминания ---------- */
  var SUGGEST = {
    tax: ["Оплата НДС", "Аванс по УСН", "НДФЛ и соцвзносы", "Отчёт в статистику"],
    pay: ["Аренда офиса", "Интернет и связь", "Коммунальные", "Лизинг", "Страховка"]
  };
  var remType = "pay";

  function initReminderModal() {
    var typeBtns = document.querySelectorAll(".rem-type-btn");
    typeBtns.forEach(function (b) {
      b.addEventListener("click", function () {
        typeBtns.forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        remType = b.getAttribute("data-type");
        renderSuggest();
      });
    });
    renderSuggest();

    // «Добавить на этот день» — подставляем выбранную дату
    var dayAdd = document.getElementById("day-add-btn");
    if (dayAdd) {
      dayAdd.addEventListener("click", function () {
        if (selectedDay) {
          var iso = selectedDay.getFullYear() + "-" +
            String(selectedDay.getMonth() + 1).padStart(2, "0") + "-" +
            String(selectedDay.getDate()).padStart(2, "0");
          document.getElementById("rem-date").value = iso;
        }
      });
    }

    document.getElementById("rem-save").addEventListener("click", function () {
      var title = document.getElementById("rem-title").value.trim();
      if (!title) {
        window.showToast && showToast("warning", "Укажите название", "Например: «Аренда офиса».");
        return;
      }
      var dateV = document.getElementById("rem-date").value;
      var d = dateV ? new Date(dateV + "T00:00:00") : new Date(today);
      var repeat = document.getElementById("rem-repeat").value;
      var remind = document.getElementById("rem-remind").value;
      var remindDays = remind === "в день события" ? 0 : remind === "за 1 день" ? 1 : remind === "за 3 дня" ? 3 : 7;

      EVENTS.push({
        date: d,
        type: remType,
        title: title,
        company: document.getElementById("rem-company").value,
        repeat: repeat === "Однократно" ? "" : repeat,
        remind: remindDays
      });
      cur = new Date(d.getFullYear(), d.getMonth(), 1);
      render();
      document.getElementById("modal-reminder").classList.remove("open");
      document.body.style.overflow = "";
      document.getElementById("rem-title").value = "";
      window.showToast && showToast("success", "Напоминание создано",
        fmt(d) + (repeat === "Однократно" ? "" : " · " + repeat.toLowerCase()) + " · бот напомнит " + remind + ".");
    });
  }

  function renderSuggest() {
    var box = document.getElementById("rem-suggest");
    box.innerHTML = "";
    SUGGEST[remType].forEach(function (sug) {
      var c = document.createElement("button");
      c.type = "button";
      c.className = "chip";
      c.textContent = sug;
      c.addEventListener("click", function () {
        document.getElementById("rem-title").value = sug;
      });
      box.appendChild(c);
    });
  }

  /* ---------- Фильтры и навигация ---------- */
  function init() {
    seed();

    document.getElementById("cal-prev").addEventListener("click", function () {
      cur = new Date(cur.getFullYear(), cur.getMonth() - 1, 1); render();
    });
    document.getElementById("cal-next").addEventListener("click", function () {
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1); render();
    });
    document.getElementById("cal-today").addEventListener("click", function () {
      cur = new Date(today.getFullYear(), today.getMonth(), 1); render();
    });

    var fbox = document.getElementById("cal-filters");
    fbox.querySelectorAll(".chip").forEach(function (c) {
      c.addEventListener("click", function () {
        fbox.querySelectorAll(".chip").forEach(function (x) { x.classList.remove("active"); });
        c.classList.add("active");
        typeFilter = c.getAttribute("data-f");
        render();
      });
    });

    var dateInput = document.getElementById("rem-date");
    if (dateInput && !dateInput.value) {
      var dv = new Date(today); dv.setDate(dv.getDate() + 7);
      dateInput.value = dv.toISOString().slice(0, 10);
    }

    initReminderModal();
    render();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
