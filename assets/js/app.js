/* ============================================================
   Finpulse CRM — app.js
   Только демонстрационная логика прототипа:
   модальные окна, drawer, dropdown, вкладки, toast,
   переключение вида, поиск, скелетоны, Telegram-демо.
   Никакой серверной логики и API.
   ============================================================ */

(function () {
  "use strict";

  /* ---------- Общие модальные окна (инжектируются на все страницы) ---------- */
  const MODALS_HTML = `
  <!-- Создать клиента -->
  <div class="modal-backdrop" id="modal-create-client">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="mcc-title">
      <div class="modal-header">
        <h2 id="mcc-title">Новый клиент</h2>
        <button class="modal-close" data-modal-close aria-label="Закрыть"><i data-lucide="x" class="icon"></i></button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Название компании <span class="req">*</span></label>
          <input type="text" class="input" placeholder="ООО «Название»">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">ИНН <span class="req">*</span></label>
            <input type="text" class="input" placeholder="7701234567">
          </div>
          <div class="form-group">
            <label class="form-label">Система налогообложения</label>
            <select class="select">
              <option>УСН (доходы)</option>
              <option>УСН (доходы − расходы)</option>
              <option>ОСНО</option>
              <option>Патент</option>
              <option>АУСН</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Контактное лицо</label>
            <input type="text" class="input" placeholder="Иванов Иван Иванович">
          </div>
          <div class="form-group">
            <label class="form-label">Телефон</label>
            <input type="tel" class="input" placeholder="+7 (900) 000-00-00">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Электронная почта</label>
            <input type="email" class="input" placeholder="info@company.ru">
          </div>
          <div class="form-group">
            <label class="form-label">Ответственный бухгалтер</label>
            <select class="select">
              <option>Елена Крылова</option>
              <option>Дмитрий Орлов</option>
              <option>Анна Смирнова</option>
              <option>Игорь Васильев</option>
              <option>Ольга Никитина</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Комментарий</label>
          <textarea class="textarea" placeholder="Дополнительная информация о клиенте"></textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-modal-close>Отмена</button>
        <button class="btn btn-primary" data-modal-close data-toast="success|Клиент создан|Карточка клиента добавлена в систему.">
          <i data-lucide="plus" class="icon"></i>Создать клиента
        </button>
      </div>
    </div>
  </div>

  <!-- Создать задачу -->
  <div class="modal-backdrop" id="modal-create-task">
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h2>Новая задача</h2>
        <button class="modal-close" data-modal-close aria-label="Закрыть"><i data-lucide="x" class="icon"></i></button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Название задачи <span class="req">*</span></label>
          <input type="text" class="input" placeholder="Например: Подготовить декларацию по НДС">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Клиент <span class="req">*</span></label>
            <select class="select">
              <option>ООО «ТехноСфера»</option>
              <option>ИП Соколова А. В.</option>
              <option>ООО «СтройГарант»</option>
              <option>АО «ВекторПлюс»</option>
              <option>ООО «Логистик Групп»</option>
              <option>ООО «МедФарм»</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Исполнитель</label>
            <select class="select">
              <option>Назначить автоматически</option>
              <option>Елена Крылова</option>
              <option>Дмитрий Орлов</option>
              <option>Анна Смирнова</option>
              <option>Игорь Васильев</option>
              <option>Ольга Никитина</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Приоритет</label>
            <select class="select">
              <option>Низкий</option>
              <option selected>Средний</option>
              <option>Высокий</option>
              <option>Критический</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Дедлайн</label>
            <div class="input-icon-wrap">
              <input type="text" class="input has-icon-right" placeholder="ДД.ММ.ГГГГ" value="20.07.2026">
              <i data-lucide="calendar" class="icon icon-right"></i>
            </div>
            <div class="form-hint">Выбор даты — макет календаря</div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Описание</label>
          <textarea class="textarea" placeholder="Что нужно сделать, сроки, особенности"></textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-modal-close>Отмена</button>
        <button class="btn btn-primary" data-modal-close data-toast="success|Задача создана|Задача добавлена и назначена исполнителю.">
          <i data-lucide="plus" class="icon"></i>Создать задачу
        </button>
      </div>
    </div>
  </div>

  <!-- Создать сотрудника -->
  <div class="modal-backdrop" id="modal-create-employee">
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h2>Новый сотрудник</h2>
        <button class="modal-close" data-modal-close aria-label="Закрыть"><i data-lucide="x" class="icon"></i></button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Фамилия <span class="req">*</span></label>
            <input type="text" class="input" placeholder="Петрова">
          </div>
          <div class="form-group">
            <label class="form-label">Имя и отчество <span class="req">*</span></label>
            <input type="text" class="input" placeholder="Мария Сергеевна">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Должность</label>
            <select class="select">
              <option>Бухгалтер</option>
              <option>Главный бухгалтер</option>
              <option>Бухгалтер по зарплате</option>
              <option>Младший бухгалтер</option>
              <option>Налоговый консультант</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Роль в системе</label>
            <select class="select">
              <option>Бухгалтер</option>
              <option>Руководитель</option>
              <option>Администратор</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Электронная почта <span class="req">*</span></label>
            <input type="email" class="input" placeholder="m.petrova@finpulse.ru">
          </div>
          <div class="form-group">
            <label class="form-label">Телефон</label>
            <input type="tel" class="input" placeholder="+7 (900) 000-00-00">
          </div>
        </div>
        <div class="form-group">
          <label class="checkbox-label">
            <input type="checkbox" checked>
            Отправить приглашение на почту
          </label>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-modal-close>Отмена</button>
        <button class="btn btn-primary" data-modal-close data-toast="success|Сотрудник добавлен|Приглашение отправлено на почту.">
          <i data-lucide="user-plus" class="icon"></i>Добавить
        </button>
      </div>
    </div>
  </div>

  <!-- Изменить задачу -->
  <div class="modal-backdrop" id="modal-edit-task">
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h2>Изменить задачу</h2>
        <button class="modal-close" data-modal-close aria-label="Закрыть"><i data-lucide="x" class="icon"></i></button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Название задачи</label>
          <input type="text" class="input" value="Подготовить декларацию по НДС за II квартал">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Статус</label>
            <select class="select">
              <option>Новая</option>
              <option selected>В работе</option>
              <option>Ожидание</option>
              <option>Выполнена</option>
              <option>Отменена</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Приоритет</label>
            <select class="select">
              <option>Низкий</option>
              <option>Средний</option>
              <option selected>Высокий</option>
              <option>Критический</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Исполнитель</label>
            <select class="select">
              <option selected>Елена Крылова</option>
              <option>Дмитрий Орлов</option>
              <option>Анна Смирнова</option>
              <option>Игорь Васильев</option>
              <option>Ольга Никитина</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Дедлайн</label>
            <div class="input-icon-wrap">
              <input type="text" class="input has-icon-right" value="25.07.2026">
              <i data-lucide="calendar" class="icon icon-right"></i>
            </div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Описание</label>
          <textarea class="textarea">Собрать первичные документы, проверить книги покупок и продаж, сформировать декларацию и отправить на согласование клиенту.</textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-modal-close>Отмена</button>
        <button class="btn btn-primary" data-modal-close data-toast="success|Изменения сохранены|Задача обновлена, история изменений дополнена.">
          <i data-lucide="check" class="icon"></i>Сохранить
        </button>
      </div>
    </div>
  </div>

  <!-- Подтверждение удаления -->
  <div class="modal-backdrop" id="modal-delete">
    <div class="modal modal-sm" role="dialog" aria-modal="true">
      <div class="modal-body" style="text-align:center; padding-top:28px;">
        <div class="confirm-icon"><i data-lucide="trash-2" class="icon"></i></div>
        <h2 style="margin-bottom:8px;">Удалить запись?</h2>
        <p class="text-secondary" style="font-size:13.5px;">Это действие нельзя отменить. Все связанные комментарии и файлы будут также удалены.</p>
      </div>
      <div class="modal-footer" style="justify-content:center;">
        <button class="btn btn-secondary" data-modal-close>Отмена</button>
        <button class="btn btn-danger" data-modal-close data-toast="error|Запись удалена|Данные удалены из системы.">Удалить</button>
      </div>
    </div>
  </div>

  <!-- Архивировать -->
  <div class="modal-backdrop" id="modal-archive">
    <div class="modal modal-sm" role="dialog" aria-modal="true">
      <div class="modal-body" style="text-align:center; padding-top:28px;">
        <div class="confirm-icon" style="background:var(--warning-bg); color:var(--warning);"><i data-lucide="archive" class="icon"></i></div>
        <h2 style="margin-bottom:8px;">Архивировать клиента?</h2>
        <p class="text-secondary" style="font-size:13.5px;">Клиент будет перемещён в архив. Активные задачи останутся доступны, новые задачи создавать будет нельзя.</p>
      </div>
      <div class="modal-footer" style="justify-content:center;">
        <button class="btn btn-secondary" data-modal-close>Отмена</button>
        <button class="btn btn-primary" data-modal-close data-toast="info|Клиент архивирован|Карточка перемещена в архив.">Архивировать</button>
      </div>
    </div>
  </div>

  <!-- Загрузка файла -->
  <div class="modal-backdrop" id="modal-upload">
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h2>Загрузка файла</h2>
        <button class="modal-close" data-modal-close aria-label="Закрыть"><i data-lucide="x" class="icon"></i></button>
      </div>
      <div class="modal-body">
        <div class="dropzone" data-toast="info|Макет|В прототипе выбор файла имитируется.">
          <i data-lucide="upload-cloud" class="icon"></i>
          <div class="fw-500">Перетащите файл сюда или нажмите для выбора</div>
          <div class="text-muted text-sm mt-8">PDF, DOCX, XLSX, JPG — до 25 МБ</div>
        </div>
        <div class="error-state mt-16">
          <i data-lucide="alert-circle" class="icon"></i>
          <div>
            <strong>Пример состояния ошибки</strong>
            <p>Файл «выписка_январь.zip» превышает допустимый размер 25 МБ.</p>
          </div>
        </div>
        <div class="form-group mt-16">
          <label class="form-label">Описание файла</label>
          <input type="text" class="input" placeholder="Например: Акт сверки за июнь">
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-modal-close>Отмена</button>
        <button class="btn btn-primary" data-modal-close data-toast="success|Файл загружен|Документ прикреплён к карточке.">
          <i data-lucide="upload" class="icon"></i>Загрузить
        </button>
      </div>
    </div>
  </div>

  <!-- Настройки распределения -->
  <div class="modal-backdrop" id="modal-distribution">
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h2>Правило автораспределения</h2>
        <button class="modal-close" data-modal-close aria-label="Закрыть"><i data-lucide="x" class="icon"></i></button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Название правила</label>
          <input type="text" class="input" value="Обращения из Telegram → ответственный бухгалтер">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Источник задачи</label>
            <select class="select">
              <option selected>Telegram</option>
              <option>Ручное создание</option>
              <option>Электронная почта</option>
              <option>Любой</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Тип распределения</label>
            <select class="select">
              <option selected>Ответственному бухгалтеру клиента</option>
              <option>Наименее загруженному сотруднику</option>
              <option>По очереди (round-robin)</option>
              <option>Конкретному сотруднику</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Приоритет по умолчанию</label>
            <select class="select">
              <option>Низкий</option>
              <option selected>Средний</option>
              <option>Высокий</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Срок выполнения</label>
            <select class="select">
              <option>1 рабочий день</option>
              <option selected>2 рабочих дня</option>
              <option>3 рабочих дня</option>
              <option>5 рабочих дней</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="checkbox-label"><input type="checkbox" checked> Уведомлять исполнителя в Telegram</label>
        </div>
        <div class="form-group">
          <label class="checkbox-label"><input type="checkbox" checked> Уведомлять руководителя при просрочке</label>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-modal-close>Отмена</button>
        <button class="btn btn-primary" data-modal-close data-toast="success|Правило сохранено|Автораспределение обновлено.">
          <i data-lucide="check" class="icon"></i>Сохранить правило
        </button>
      </div>
    </div>
  </div>

  <!-- Drawer: быстрый просмотр задачи -->
  <div class="drawer-backdrop" id="drawer-task">
    <aside class="drawer" role="dialog" aria-modal="true">
      <div class="drawer-header">
        <div>
          <div class="text-muted text-xs" style="text-transform:uppercase; letter-spacing:0.05em; font-weight:600;">Быстрый просмотр</div>
          <h2 id="drawer-task-title" style="font-size:16px; margin-top:2px;">Подготовить декларацию по НДС за II квартал</h2>
        </div>
        <button class="modal-close" data-drawer-close aria-label="Закрыть"><i data-lucide="x" class="icon"></i></button>
      </div>
      <div class="drawer-body">
        <div class="flex gap-8 mb-16">
          <span class="badge badge-blue">В работе</span>
          <span class="badge badge-yellow">Высокий приоритет</span>
        </div>
        <dl class="drawer-meta">
          <dt>Клиент</dt><dd><a href="client.html">ООО «ТехноСфера»</a></dd>
          <dt>Исполнитель</dt><dd>Елена Крылова</dd>
          <dt>Дедлайн</dt><dd>25.07.2026</dd>
          <dt>Создана</dt><dd>02.07.2026, из Telegram</dd>
          <dt>Комментарии</dt><dd>3</dd>
          <dt>Файлы</dt><dd>2</dd>
        </dl>
        <h4 class="mt-24 mb-8">Описание</h4>
        <p class="text-secondary" style="font-size:13.5px;">Собрать первичные документы, проверить книги покупок и продаж, сформировать декларацию и отправить на согласование клиенту до 25 июля.</p>
        <h4 class="mt-24 mb-8">Последний комментарий</h4>
        <div class="comment" style="padding:12px 0 0; border:none;">
          <span class="avatar avatar-sm av-1">ЕК</span>
          <div>
            <div class="comment-head"><span class="comment-author">Елена Крылова</span><span class="comment-time">сегодня, 11:24</span></div>
            <div class="comment-text">Книга покупок сверена, жду счета-фактуры от поставщика.</div>
          </div>
        </div>
      </div>
      <div class="drawer-footer">
        <a href="task.html" class="btn btn-primary" style="flex:1;"><i data-lucide="external-link" class="icon"></i>Открыть задачу</a>
        <button class="btn btn-secondary" data-modal-open="modal-edit-task" data-drawer-close><i data-lucide="pencil" class="icon"></i>Изменить</button>
      </div>
    </aside>
  </div>

  <div class="toast-container" id="toast-container"></div>
  `;

  /* ---------- Инициализация ---------- */
  document.addEventListener("DOMContentLoaded", function () {
    // Инжекция модальных окон (кроме страницы входа)
    if (!document.body.classList.contains("no-shell")) {
      const wrap = document.createElement("div");
      wrap.innerHTML = MODALS_HTML;
      document.body.appendChild(wrap);
    } else {
      const tc = document.createElement("div");
      tc.className = "toast-container";
      tc.id = "toast-container";
      document.body.appendChild(tc);
    }

    initRole();

    if (window.lucide) lucide.createIcons();

    initSidebar();
    initDropdowns();
    initModals();
    initDrawers();
    initTabs();
    initToastTriggers();
    initViewToggle();
    initSearchFilter();
    initSortableHeaders();
    initSkeletons();
    initTodayTasks();
    initTelegramDemo();
    initPagination();
  });

  /* ---------- Ролевой доступ (демо) ---------- */
  var PERSONAS = {
    admin: {
      init: "ЮИ", av: "av-6",
      name: "Ибрагимова Юлдуз",
      role: "Главный бухгалтер · супер-админ",
      short: "Юлдуз",
      label: "Супер-админ"
    },
    accountant: {
      init: "ЕК", av: "av-1",
      name: "Елена Крылова",
      role: "Бухгалтер",
      short: "Елена",
      label: "Бухгалтер"
    }
  };

  function getRole() {
    try { return localStorage.getItem("demoRole") === "accountant" ? "accountant" : "admin"; }
    catch (e) { return "admin"; }
  }

  function applyRole(role) {
    var p = PERSONAS[role];
    document.body.classList.toggle("role-accountant", role === "accountant");

    var lbl = document.getElementById("role-label");
    if (lbl) lbl.textContent = p.label;

    // Пользователь в sidebar
    var su = document.querySelector(".sidebar-user");
    if (su) {
      var av = su.querySelector(".avatar");
      if (av) { av.textContent = p.init; av.className = "avatar " + p.av; }
      var nm = su.querySelector(".name");
      if (nm) nm.textContent = p.name;
      var rl = su.querySelector(".role");
      if (rl) rl.textContent = p.role;
    }
    // Профиль в topbar
    var tp = document.querySelector(".topbar-profile");
    if (tp) {
      var tav = tp.querySelector(".avatar");
      if (tav) { tav.textContent = p.init; tav.className = "avatar avatar-sm " + p.av; }
      var pn = tp.querySelector(".profile-name");
      if (pn) pn.textContent = p.short;
    }
  }

  function initRole() {
    if (document.body.classList.contains("no-shell")) return;

    // Переключатель роли в topbar (демонстрация ролевого доступа)
    var actions = document.querySelector(".topbar-actions");
    if (actions) {
      var dd = document.createElement("div");
      dd.className = "dropdown role-switch";
      dd.innerHTML =
        '<button class="btn btn-secondary btn-sm" data-dropdown-toggle>' +
          '<span class="role-dot"></span><span class="role-label-text" id="role-label"></span>' +
          '<i data-lucide="chevron-down" class="icon icon-sm"></i>' +
        "</button>" +
        '<div class="dropdown-menu">' +
          '<div class="dropdown-header">Режим просмотра (демо ролей)</div>' +
          '<button class="dropdown-item" data-set-role="admin"><i data-lucide="shield-check" class="icon"></i>' +
            "<span>Супер-админ<br><span class=\"text-muted text-xs\">Ибрагимова Юлдуз Ахмедовна — видит всё</span></span></button>" +
          '<button class="dropdown-item" data-set-role="accountant"><i data-lucide="user" class="icon"></i>' +
            "<span>Бухгалтер<br><span class=\"text-muted text-xs\">Елена Крылова — только данные для работы</span></span></button>" +
        "</div>";
      actions.insertBefore(dd, actions.firstChild);

      dd.addEventListener("click", function (e) {
        var b = e.target.closest("[data-set-role]");
        if (!b) return;
        var role = b.getAttribute("data-set-role");
        try { localStorage.setItem("demoRole", role); } catch (e2) {}
        applyRole(role);
        showToast(
          "info",
          "Роль: " + PERSONAS[role].label,
          role === "accountant"
            ? "Личные данные клиентов скрыты, административные действия недоступны."
            : "Полный доступ: видны все данные и настройки системы."
        );
      });
    }

    applyRole(getRole());
  }

  /* ---------- Sidebar (мобильный) ---------- */
  function initSidebar() {
    const burger = document.querySelector("[data-sidebar-toggle]");
    const overlay = document.querySelector(".sidebar-overlay");
    if (burger) burger.addEventListener("click", () => document.body.classList.toggle("sidebar-open"));
    if (overlay) overlay.addEventListener("click", () => document.body.classList.remove("sidebar-open"));
  }

  /* ---------- Dropdown ---------- */
  function initDropdowns() {
    document.addEventListener("click", function (e) {
      const trigger = e.target.closest("[data-dropdown-toggle]");
      const openMenus = document.querySelectorAll(".dropdown.open");
      if (trigger) {
        const dd = trigger.closest(".dropdown");
        openMenus.forEach((m) => { if (m !== dd) m.classList.remove("open"); });
        dd.classList.toggle("open");
        e.stopPropagation();
        return;
      }
      if (!e.target.closest(".dropdown-menu")) {
        openMenus.forEach((m) => m.classList.remove("open"));
      }
    });
  }

  /* ---------- Модальные окна ---------- */
  function openModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.classList.add("open");
    document.body.style.overflow = "hidden";
  }
  function closeModal(m) {
    m.classList.remove("open");
    document.body.style.overflow = "";
  }

  function initModals() {
    document.addEventListener("click", function (e) {
      const opener = e.target.closest("[data-modal-open]");
      if (opener) {
        e.preventDefault();
        openModal(opener.getAttribute("data-modal-open"));
        document.querySelectorAll(".dropdown.open").forEach((d) => d.classList.remove("open"));
        return;
      }
      const closer = e.target.closest("[data-modal-close]");
      if (closer) {
        const bd = closer.closest(".modal-backdrop");
        if (bd) closeModal(bd);
        return;
      }
      if (e.target.classList.contains("modal-backdrop")) closeModal(e.target);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        document.querySelectorAll(".modal-backdrop.open").forEach(closeModal);
        document.querySelectorAll(".drawer-backdrop.open").forEach((d) => d.classList.remove("open"));
        document.body.style.overflow = "";
      }
    });
  }

  /* ---------- Drawer ---------- */
  function initDrawers() {
    document.addEventListener("click", function (e) {
      const opener = e.target.closest("[data-drawer-open]");
      if (opener) {
        e.preventDefault();
        const d = document.getElementById(opener.getAttribute("data-drawer-open"));
        if (d) {
          const t = opener.getAttribute("data-task-title");
          const titleEl = document.getElementById("drawer-task-title");
          if (t && titleEl) titleEl.textContent = t;
          d.classList.add("open");
        }
        return;
      }
      const closer = e.target.closest("[data-drawer-close]");
      if (closer) {
        const bd = closer.closest(".drawer-backdrop");
        if (bd) bd.classList.remove("open");
        return;
      }
      if (e.target.classList.contains("drawer-backdrop")) e.target.classList.remove("open");
    });
  }

  /* ---------- Вкладки ---------- */
  function initTabs() {
    document.querySelectorAll("[data-tabs]").forEach(function (group) {
      const btns = group.querySelectorAll(".tab-btn");
      btns.forEach(function (btn) {
        btn.addEventListener("click", function () {
          btns.forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          const scope = group.getAttribute("data-tabs");
          document.querySelectorAll('.tab-panel[data-tab-scope="' + scope + '"]').forEach(function (p) {
            p.classList.toggle("active", p.id === btn.getAttribute("data-tab-target"));
          });
        });
      });
    });
  }

  /* ---------- Toast ---------- */
  const TOAST_ICONS = { success: "check-circle", error: "alert-circle", info: "info", warning: "alert-triangle" };

  function showToast(type, title, text) {
    const container = document.getElementById("toast-container");
    if (!container) return;
    const el = document.createElement("div");
    el.className = "toast " + (type || "info");
    el.innerHTML =
      '<div class="toast-icon"><i data-lucide="' + (TOAST_ICONS[type] || "info") + '" class="icon"></i></div>' +
      '<div><div class="toast-title">' + title + "</div>" +
      (text ? '<div class="toast-text">' + text + "</div>" : "") +
      "</div>" +
      '<button class="toast-close" aria-label="Закрыть"><i data-lucide="x" class="icon icon-sm"></i></button>';
    container.appendChild(el);
    if (window.lucide) lucide.createIcons({ nameAttr: "data-lucide" });
    const remove = function () {
      el.classList.add("closing");
      setTimeout(() => el.remove(), 200);
    };
    el.querySelector(".toast-close").addEventListener("click", remove);
    setTimeout(remove, 4200);
  }
  window.showToast = showToast;

  function initToastTriggers() {
    document.addEventListener("click", function (e) {
      const t = e.target.closest("[data-toast]");
      if (!t) return;
      const parts = t.getAttribute("data-toast").split("|");
      showToast(parts[0], parts[1] || "Готово", parts[2] || "");
    });
  }

  /* ---------- Переключение Таблица / Канбан ---------- */
  function initViewToggle() {
    const toggle = document.querySelector("[data-view-toggle]");
    if (!toggle) return;
    toggle.querySelectorAll("button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        toggle.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const view = btn.getAttribute("data-view");
        document.querySelectorAll("[data-view-panel]").forEach(function (p) {
          p.classList.toggle("hidden", p.getAttribute("data-view-panel") !== view);
        });
      });
    });
  }

  /* ---------- Поиск по таблице + Empty State ---------- */
  function initSearchFilter() {
    document.querySelectorAll("[data-table-search]").forEach(function (input) {
      const tableId = input.getAttribute("data-table-search");
      const table = document.getElementById(tableId);
      if (!table) return;
      const emptyEl = document.querySelector('[data-empty-for="' + tableId + '"]');
      input.addEventListener("input", function () {
        const q = input.value.trim().toLowerCase();
        let visible = 0;
        table.querySelectorAll("tbody tr").forEach(function (row) {
          const show = row.textContent.toLowerCase().includes(q);
          row.style.display = show ? "" : "none";
          if (show) visible++;
        });
        if (emptyEl) emptyEl.classList.toggle("hidden", visible > 0);
        const wrap = table.closest(".table-wrap");
        if (wrap) wrap.classList.toggle("hidden", visible === 0 && emptyEl);
      });
    });
  }

  /* ---------- Сортировка колонок (демо) ---------- */
  function initSortableHeaders() {
    document.querySelectorAll(".table th.sortable").forEach(function (th) {
      th.addEventListener("click", function () {
        const table = th.closest("table");
        const tbody = table.querySelector("tbody");
        const idx = Array.from(th.parentNode.children).indexOf(th);
        const asc = th.dataset.sort !== "asc";
        table.querySelectorAll("th.sortable").forEach((h) => delete h.dataset.sort);
        th.dataset.sort = asc ? "asc" : "desc";
        Array.from(tbody.querySelectorAll("tr"))
          .sort(function (a, b) {
            const av = a.children[idx].textContent.trim();
            const bv = b.children[idx].textContent.trim();
            const an = parseFloat(av.replace(",", "."));
            const bn = parseFloat(bv.replace(",", "."));
            const cmp = !isNaN(an) && !isNaN(bn) ? an - bn : av.localeCompare(bv, "ru");
            return asc ? cmp : -cmp;
          })
          .forEach((r) => tbody.appendChild(r));
        showToast("info", "Сортировка применена", "Колонка: «" + th.textContent.trim() + "», " + (asc ? "по возрастанию" : "по убыванию") + ".");
      });
    });
  }

  /* ---------- Loading State: скелетоны при загрузке ---------- */
  function initSkeletons() {
    const els = document.querySelectorAll("[data-skeleton]");
    if (!els.length) return;
    els.forEach((el) => el.classList.add("skeleton"));
    setTimeout(function () {
      els.forEach((el) => el.classList.remove("skeleton"));
    }, 700);
  }

  /* ---------- Задачи на сегодня: чекбоксы ---------- */
  function initTodayTasks() {
    document.querySelectorAll(".today-task input[type=checkbox]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        cb.closest(".today-task").classList.toggle("done", cb.checked);
        if (cb.checked) showToast("success", "Задача выполнена", "Статус обновлён.");
      });
    });
  }

  /* ---------- Пагинация (демо) ---------- */
  function initPagination() {
    document.querySelectorAll(".pagination-pages").forEach(function (pages) {
      pages.querySelectorAll(".page-btn[data-page]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          pages.querySelectorAll(".page-btn").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          showToast("info", "Страница " + btn.dataset.page, "В прототипе пагинация демонстрационная.");
        });
      });
    });
  }

  /* ---------- Telegram: демонстрация потока ---------- */
  function initTelegramDemo() {
    const playBtn = document.getElementById("tg-play");
    if (!playBtn) return;

    const steps = Array.from(document.querySelectorAll(".tg-step"));
    const chat = document.getElementById("tg-chat");
    const events = Array.from(document.querySelectorAll("#tg-events .timeline-item"));

    function reset() {
      steps.forEach((s) => s.classList.remove("active", "done"));
      events.forEach((ev) => ev.classList.add("hidden"));
      if (chat) chat.querySelectorAll(".chat-msg.demo").forEach((m) => m.remove());
    }

    playBtn.addEventListener("click", function () {
      reset();
      playBtn.disabled = true;
      playBtn.style.opacity = "0.6";

      const timeline = [
        function () {
          activate(0);
          addMsg("in", "Добрый день! Пришло требование из налоговой по НДС, нужна помощь до пятницы. Прикладываю скан.", "14:02");
        },
        function () {
          activate(1);
          showEvent(0);
        },
        function () {
          activate(2);
          showEvent(1);
        },
        function () {
          activate(3);
          showEvent(2);
          addMsg("out", "Здравствуйте! Обращение принято, создана задача №1247. Ответственный бухгалтер: Елена Крылова. Срок: 10.07.2026.", "14:03");
        },
        function () {
          steps.forEach((s) => { s.classList.remove("active"); s.classList.add("done"); });
          showToast("success", "Демонстрация завершена", "Задача создана и распределена автоматически.");
          playBtn.disabled = false;
          playBtn.style.opacity = "";
        }
      ];

      timeline.forEach(function (fn, i) {
        setTimeout(fn, 900 * (i + 1));
      });
    });

    function activate(i) {
      steps.forEach(function (s, idx) {
        s.classList.toggle("active", idx === i);
        s.classList.toggle("done", idx < i);
      });
    }
    function showEvent(i) {
      if (events[i]) events[i].classList.remove("hidden");
    }
    function addMsg(dir, text, time) {
      if (!chat) return;
      const m = document.createElement("div");
      m.className = "chat-msg demo " + dir;
      m.innerHTML = text + '<span class="msg-time">' + time + "</span>";
      chat.appendChild(m);
      chat.scrollTop = chat.scrollHeight;
    }
  }
})();
