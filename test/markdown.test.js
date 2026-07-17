const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mdToTelegramHtml } = require("../lib/markdown.js");

test("mdToTelegramHtml: bold conversion", () => {
  assert.equal(mdToTelegramHtml("**hello**"), "<b>hello</b>");
});

test("mdToTelegramHtml: inline code conversion", () => {
  assert.equal(mdToTelegramHtml("`code`"), "<code>code</code>");
});

test("mdToTelegramHtml: bullet list gets bullet prefix, not literal - / *", () => {
  const out = mdToTelegramHtml("- first\n* second");
  assert.equal(out, "• first\n• second");
});

test("mdToTelegramHtml: escapes HTML special chars", () => {
  assert.equal(mdToTelegramHtml("<script>a & b</script>"), "&lt;script&gt;a &amp; b&lt;/script&gt;");
});

test("mdToTelegramHtml: mixed bold + bullet + escaping in one call", () => {
  const out = mdToTelegramHtml("- **важно**: сумма < 5000");
  assert.equal(out, "• <b>важно</b>: сумма &lt; 5000");
});
