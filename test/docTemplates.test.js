const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  renderTemplate, missingRequired, templatePlaceholders, autofillFromClient,
  suggestTemplateForClient, recordTemplateUsage, listTemplates, addTemplate,
} = require("../lib/docTemplates.js");

function fakeRedis() {
  const store = new Map();
  const sets = new Map();
  return {
    get: async (k) => (store.has(k) ? store.get(k) : null),
    set: async (k, v) => { store.set(k, v); return "OK"; },
    del: async (k) => { store.delete(k); },
    sadd: async (k, v) => { if (!sets.has(k)) sets.set(k, new Set()); sets.get(k).add(v); },
    srem: async (k, v) => { if (sets.has(k)) sets.get(k).delete(v); },
    smembers: async (k) => (sets.has(k) ? [...sets.get(k)] : []),
    mget: async (...ks) => ks.map((k) => (store.has(k) ? store.get(k) : null)),
    incr: async (k) => { const v = (store.get(k) || 0) + 1; store.set(k, v); return v; },
  };
}

test("templatePlaceholders: finds all {{x}} tokens once each", () => {
  const ph = templatePlaceholders("Hello {{name}}, your {{amount}} is due {{name}}");
  assert.deepEqual(ph.sort(), ["amount", "name"]);
});

test("renderTemplate: fills known fields, marks missing ones explicitly", () => {
  const out = renderTemplate("{{a}} and {{b}}", { a: "X" });
  assert.equal(out, "X and [НЕ ЗАПОЛНЕНО: b]");
});

test("missingRequired: only reports required fields absent from fields", () => {
  const tpl = { requiredFields: ["subject", "amount"] };
  assert.deepEqual(missingRequired(tpl, { subject: "x" }), ["amount"]);
  assert.deepEqual(missingRequired(tpl, { subject: "x", amount: "y" }), []);
});

test("autofillFromClient: pulls organization fields, never invents director/subject", () => {
  const filled = autofillFromClient({ company: "Acme", inn: "123" }, { name: "Cp", inn: "999" });
  assert.equal(filled.organization, "Acme");
  assert.equal(filled.organizationInn, "123");
  assert.equal(filled.counterparty, "Cp");
  assert.equal(filled.counterpartyInn, "999");
  assert.equal("director" in filled, false);
  assert.equal("subject" in filled, false);
});

test("listTemplates: seeds 4 defaults exactly once, no duplicates on repeat calls", async () => {
  const redis = fakeRedis();
  const first = await listTemplates(redis);
  assert.equal(first.length, 4);
  const second = await listTemplates(redis);
  assert.equal(second.length, 4);
});

test("suggestTemplateForClient: returns most-used template for that client, null if no history", async () => {
  const redis = fakeRedis();
  const tpl = await addTemplate(redis, { name: "T1", body: "{{x}}", requiredFields: [] });
  const none = await suggestTemplateForClient(redis, "Acme");
  assert.equal(none, null);
  await recordTemplateUsage(redis, "Acme", tpl.id);
  await recordTemplateUsage(redis, "Acme", tpl.id);
  const suggestion = await suggestTemplateForClient(redis, "Acme");
  assert.equal(suggestion.templateId, tpl.id);
  assert.equal(suggestion.usedCount, 2);
});
