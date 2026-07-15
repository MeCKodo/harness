const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

test("renderer exposes the visible notes controls", () => {
  const html = readFileSync(join(__dirname, "../../src/renderer/index.html"), "utf8");
  assert.match(html, /<h1>Desktop Notes<\/h1>/);
  assert.match(html, /id="load-notes"/);
});
