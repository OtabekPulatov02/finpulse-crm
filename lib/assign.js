/* ============================================================
   Finpulse CRM — правила автораспределения задач.

   Хранится один список правил (assign:rules), каждое:
   { id, name, enabled, source: "any"|"telegram"|"crm",
     keywords: string[]  — совпадение по любому слову (OR, без учёта регистра),
     assignTo: "least_loaded" | employeeId,
     priority: "Низкий"|"Средний"|"Высокий"|"Критический"|null,
     dueDays: number|null }

   Правила проверяются по порядку списка, срабатывает первое совпавшее
   (keywords пустой массив = совпадает всегда, полезно как правило-заглушка
   "всё остальное → X" в конце списка). Если ни одно правило не сработало —
   задача остаётся как раньше, без исполнителя ("new").

   Это единственное место, где применяется автораспределение — вызывается
   из createTaskFromCrm (api/crm.js) и createTaskFromDraft (api/bot.js)
   сразу после того, как объект задачи собран, но до записи в Redis.
   ============================================================ */

async function getAssignRules(redis) {
  const rules = (await redis.get("assign:rules")) || [];
  return Array.isArray(rules) ? rules : [];
}

async function saveAssignRules(redis, rules) {
  const clean = (Array.isArray(rules) ? rules : [])
    .filter((r) => r && r.name)
    .slice(0, 30)
    .map((r, i) => ({
      id: String(r.id || "rule" + i).slice(0, 24),
      name: String(r.name).slice(0, 80),
      enabled: r.enabled !== false,
      source: r.source === "telegram" || r.source === "crm" ? r.source : "any",
      keywords: Array.isArray(r.keywords) ? r.keywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean).slice(0, 15) : [],
      assignTo: r.assignTo ? String(r.assignTo).slice(0, 40) : "least_loaded",
      priority: ["Низкий", "Средний", "Высокий", "Критический"].includes(r.priority) ? r.priority : null,
      dueDays: r.dueDays == null || r.dueDays === "" ? null : Math.max(0, Math.min(90, Number(r.dueDays) || 0)),
    }));
  await redis.set("assign:rules", clean);
  return clean;
}

function matchRule(rule, text, source) {
  if (!rule.enabled) return false;
  if (rule.source !== "any" && rule.source !== source) return false;
  if (!rule.keywords.length) return true; // правило без ключевых слов = совпадает всегда
  const lower = String(text || "").toLowerCase();
  return rule.keywords.some((kw) => lower.includes(kw));
}

/* least_loaded: активный сотрудник (role admin/accountant, active!==false) с
   наименьшим числом активных задач (new/in_progress) среди последних ~80
   задач (такой же способ перечисления, что и listTasks в api/crm.js — в
   системе нет отдельного индекса "все задачи", только counter:task). При
   равенстве нагрузки — по порядку списка сотрудников (стабильно). */
async function pickLeastLoadedEmployee(redis) {
  try {
    const ids = (await redis.smembers("employees")) || [];
    const employees = (await Promise.all(ids.map((id) => redis.get("employee:" + id))))
      .filter((e) => e && e.active !== false && (e.role === "admin" || e.role === "accountant"));
    if (!employees.length) return null;

    const n = Number((await redis.get("counter:task")) || 0);
    const loadByName = {};
    if (n) {
      const max = 100 + n;
      const from = Math.max(101, max - 79);
      const keys = [];
      for (let i = max; i >= from; i--) keys.push("task:" + i);
      const tasks = keys.length ? await redis.mget(...keys) : [];
      for (const t of tasks) {
        if (t && (t.status === "new" || t.status === "in_progress") && t.assignee) {
          loadByName[t.assignee] = (loadByName[t.assignee] || 0) + 1;
        }
      }
    }
    let best = employees[0];
    let bestLoad = loadByName[best.name] || 0;
    for (const e of employees.slice(1)) {
      const load = loadByName[e.name] || 0;
      if (load < bestLoad) { best = e; bestLoad = load; }
    }
    return best;
  } catch (e) {
    return null;
  }
}

/* Возвращает патч, который нужно применить к объекту задачи ДО записи в
   Redis: { assignee?, status?, priority?, dueDate? }. Ничего не пишет сама —
   вызывающий код сам решает как сохранить (у crm.js и bot.js разные формы
   объекта задачи). Если ни одно правило не подошло — возвращает {}. */
async function computeAssignPatch(redis, { text, source, alreadyAssigned }) {
  if (alreadyAssigned) return {};
  try {
    const rules = await getAssignRules(redis);
    for (const rule of rules) {
      if (!matchRule(rule, text, source)) continue;
      const patch = {};
      if (rule.assignTo === "least_loaded") {
        const emp = await pickLeastLoadedEmployee(redis);
        if (emp) { patch.assignee = emp.name; patch.status = "in_progress"; }
      } else {
        const emp = await redis.get("employee:" + rule.assignTo);
        if (emp && emp.active !== false) { patch.assignee = emp.name; patch.status = "in_progress"; }
      }
      if (rule.priority) patch.priority = rule.priority;
      if (rule.dueDays != null && !patch.dueDate) {
        const d = new Date();
        d.setDate(d.getDate() + rule.dueDays);
        patch.dueDate = d.toISOString().slice(0, 10);
      }
      if (Object.keys(patch).length) return { ...patch, matchedRule: rule.name };
      return {};
    }
    return {};
  } catch (e) {
    return {};
  }
}

module.exports = { getAssignRules, saveAssignRules, computeAssignPatch, pickLeastLoadedEmployee, matchRule };
