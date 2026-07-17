const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fuzzyScore } = require("../lib/fuzzy.js");

test("fuzzyScore: exact match = 1", () => {
  assert.equal(fuzzyScore("finpulse", "finpulse"), 1);
});

test("fuzzyScore: substring = 0.85", () => {
  assert.equal(fuzzyScore("ооо finpulse", "finpulse"), 0.85);
});

test("fuzzyScore: empty inputs = 0", () => {
  assert.equal(fuzzyScore("", "finpulse"), 0);
  assert.equal(fuzzyScore("finpulse", ""), 0);
  assert.equal(fuzzyScore(null, "finpulse"), 0);
});

test("fuzzyScore: shared significant words score between 0 and 1", () => {
  const s = fuzzyScore("phoenix systems groupp", "phoenix systems ltd");
  assert.ok(s > 0 && s < 1, `expected 0 < score < 1, got ${s}`);
});

test("fuzzyScore: completely unrelated names score 0", () => {
  assert.equal(fuzzyScore("red team tashkent", "prestige club"), 0);
});
