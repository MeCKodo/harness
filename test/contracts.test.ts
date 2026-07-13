import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptContractCmd } from "../src/commands/accept";
import { baselinePath, readBaseline, runCapture, writeBaseline } from "../src/contracts";

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

test("runCapture times out a hung repository command", () => {
  const cap = runCapture(tmp(), `node -e "setTimeout(() => {}, 5000)"`, 50);
  assert.equal(cap.ok, false);
  assert.equal(cap.timedOut, true);
});

test("baseline round-trips and reads null before it is written", () => {
  const repo = tmp();
  assert.equal(readBaseline(repo, "http-api"), null);
  writeBaseline(repo, "http-api", "route-fingerprint\n");
  assert.equal(readBaseline(repo, "http-api"), "route-fingerprint\n");
});

test("baseline paths reject traversal and cannot follow a final-file symlink outside contract storage", () => {
  const repo = tmp();
  assert.throws(() => baselinePath(repo, "../../../escape"), /unsafe contract id/);
  assert.throws(() => writeBaseline(repo, "../../../escape", "owned\n"), /unsafe contract id/);

  const outside = join(tmp(), "outside.snapshot");
  writeFileSync(outside, "preserve\n");
  mkdirSync(join(repo, ".agents/contracts"), { recursive: true });
  symlinkSync(outside, join(repo, ".agents/contracts/http-api.snapshot"));
  assert.throws(() => writeBaseline(repo, "http-api", "overwrite\n"), /regular file/);
  assert.equal(readFileSync(outside, "utf8"), "preserve\n");

  const linkedRepo = tmp();
  const outsideDirectory = tmp();
  mkdirSync(join(linkedRepo, ".agents"), { recursive: true });
  symlinkSync(outsideDirectory, join(linkedRepo, ".agents/contracts"));
  assert.throws(() => writeBaseline(linkedRepo, "http-api", "outside\n"), /real directory/);
  assert.equal(existsSync(join(outsideDirectory, "http-api.snapshot")), false);
});

test("accept-contract validates an unsafe manifest before executing its snapshot command", () => {
  const repo = tmp();
  mkdirSync(join(repo, ".agents"), { recursive: true });
  writeFileSync(
    join(repo, ".agents/manifest.yaml"),
    JSON.stringify({
      spec: "ai-harness/v0",
      identity: { name: "unsafe", summary: "unsafe contract fixture" },
      contracts: [
        {
          id: "../../../escape",
          kind: "api",
          desc: "must be rejected",
          snapshot: `node -e "require('fs').writeFileSync('snapshot-ran','yes');process.stdout.write('fingerprint')"`,
        },
      ],
    }),
  );

  assert.equal(acceptContractCmd(repo), 1);
  assert.equal(existsSync(join(repo, "snapshot-ran")), false);
  assert.equal(existsSync(join(repo, "escape.snapshot")), false);
});
