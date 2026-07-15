const assert = require("node:assert/strict");
const test = require("node:test");
const { windowOptions } = require("../../electron/main/window-options.cjs");

test("desktop window keeps the preload boundary isolated", () => {
  const options = windowOptions();
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.match(options.webPreferences.preload, /electron[\\/]preload[\\/]index\.cjs$/);
});
