const { test } = require("node:test");
const assert = require("node:assert/strict");
const { matchRule, computeAssignPatch } = require("../lib/assign.js");

test("matchRule: disabled rule never matches", () => {
  const rule = { enabled: false, source: "any", keywords: [] };
  assert.equal(matchRule(rule, "любой текст", "crm"), false);
});

test("matchRule: source mismatch fails even with matching keywords", () => {
  const rule = { enabled: true, source: "telegram", keywords: ["зарплат"] };
  assert.equal(matchRule(rule, "выплата зарплаты", "crm"), false);
  assert.equal(matchRule(rule, "выплата зарплаты", "telegram"), true);
});

test("matchRule: empty keywords = matches everything (catch-all rule)", () => {
  const rule = { enabled: true, source: "any", keywords: [] };
  assert.equal(matchRule(rule, "что угодно", "crm"), true);
});

test("matchRule: keyword match is case-insensitive substring OR", () => {
  const rule = { enabled: true, source: "any", keywords: ["ндс", "проверка"] };
  assert.equal(matchRule(rule, "Пришло требование по НДС", "crm"), true);
  assert.equal(matchRule(rule, "нужна проверка кассы", "crm"), true);
  assert.equal(matchRule(rule, "выставить счёт", "crm"), false);
});

/* Минимальный in-memory фейк Redis — реализует только методы, которые
   реально использует lib/assign.js (get/set/smembers/mget), без сети. */
function makeFakeRedis(store) {
  return {
    async get(k) { return store[k] ?? null; },
    async set(k, v) { store[k] = v; },
    async smembers(k) { return store[k] ?? []; },
    async mget(...keys) { return keys.map((k) => store[k] ?? null); },
  };
}

test("computeAssignPatch: no rules configured -> empty patch", async () => {
  const redis = makeFakeRedis({ "assign:rules": [] });
  const patch = await computeAssignPatch(redis, { text: "выставить счёт", source: "crm", alreadyAssigned: false });
  assert.deepEqual(patch, {});
});

test("computeAssignPatch: already assigned -> skipped entirely", async () => {
  const redis = makeFakeRedis({
    "assign:rules": [{ id: "r1", name: "catch-all", enabled: true, source: "any", keywords: [], assignTo: "least_loaded", priority: "Высокий", dueDays: null }],
  });
  const patch = await computeAssignPatch(redis, { text: "что угодно", source: "crm", alreadyAssigned: true });
  assert.deepEqual(patch, {});
});

test("computeAssignPatch: matched rule assigns least-loaded employee + priority + dueDays", async () => {
  const store = {
    "assign:rules": [{ id: "r1", name: "salary", enabled: true, source: "any", keywords: ["зарплат"], assignTo: "least_loaded", priority: "Высокий", dueDays: 2 }],
    employees: ["e1", "e2"],
    "employee:e1": { id: "e1", name: "Бухгалтер А", role: "accountant", active: true },
    "employee:e2": { id: "e2", name: "Бухгалтер Б", role: "accountant", active: true },
    "counter:task": 0,
  };
  const redis = makeFakeRedis(store);
  const patch = await computeAssignPatch(redis, { text: "выплата зарплаты за март", source: "crm", alreadyAssigned: false });
  assert.equal(patch.assignee, "Бухгалтер А"); // первый по списку при равной (нулевой) загрузке
  assert.equal(patch.status, "in_progress");
  assert.equal(patch.priority, "Высокий");
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(patch.dueDate));
});

test("computeAssignPatch: explicit employeeId rule assigns that employee directly", async () => {
  const store = {
    "assign:rules": [{ id: "r1", name: "to-e2", enabled: true, source: "any", keywords: [], assignTo: "e2", priority: null, dueDays: null }],
    "employee:e2": { id: "e2", name: "Бухгалтер Б", role: "accountant", active: true },
  };
  const redis = makeFakeRedis(store);
  const patch = await computeAssignPatch(redis, { text: "любая задача", source: "crm", alreadyAssigned: false });
  assert.equal(patch.assignee, "Бухгалтер Б");
});

test("computeAssignPatch: rule pointing at inactive employee falls through with no patch", async () => {
  const store = {
    "assign:rules": [{ id: "r1", name: "to-inactive", enabled: true, source: "any", keywords: [], assignTo: "e3", priority: null, dueDays: null }],
    "employee:e3": { id: "e3", name: "Уволенный", role: "accountant", active: false },
  };
  const redis = makeFakeRedis(store);
  const patch = await computeAssignPatch(redis, { text: "любая задача", source: "crm", alreadyAssigned: false });
  assert.deepEqual(patch, {});
});
