import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBaseline, runCapture, writeBaseline } from "../src/contracts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "harness-contract-"));
}

test("runCapture returns stdout on success", () => {
  const cap = runCapture(tmp(), "printf hello");
  assert.equal(cap.ok, true);
  assert.equal(cap.stdout, "hello");
});

test("runCapture reports failure (non-zero exit) instead of throwing", () => {
  const cap = runCapture(tmp(), "exit 3");
  assert.equal(cap.ok, false);
  assert.equal(cap.stdout, "");
});

test("baseline round-trips and reads null before it is written", () => {
  const repo = tmp();
  assert.equal(readBaseline(repo, "http-api"), null);
  writeBaseline(repo, "http-api", "route-fingerprint\n");
  assert.equal(readBaseline(repo, "http-api"), "route-fingerprint\n");
});
