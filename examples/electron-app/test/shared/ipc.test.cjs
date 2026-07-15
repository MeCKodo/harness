const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const { NOTES_LIST_CHANNEL, isNotesListRequest } = require("../../src/shared/ipc.cjs");

test("notes:list contract rejects malformed requests", () => {
  assert.equal(NOTES_LIST_CHANNEL, "notes:list");
  assert.equal(isNotesListRequest({ workspaceId: "inbox" }), true);
  assert.equal(isNotesListRequest({ workspaceId: "" }), false);
  const preload = readFileSync(join(__dirname, "../../electron/preload/index.cjs"), "utf8");
  assert.match(preload, new RegExp(`NOTES_LIST_CHANNEL = ["']${NOTES_LIST_CHANNEL}["']`));
});
