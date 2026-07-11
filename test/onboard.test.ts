import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLoopCmd } from "../src/commands/check-loop";
import { onboardCmd } from "../src/commands/onboard";

test("onboard prints the skill body with a meta header and exits 0", () => {
  const orig = process.stdout.write;
  const chunks: string[] = [];
  process.stdout.write = ((s: string | Uint8Array): boolean => {
    chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = onboardCmd();
  } finally {
    process.stdout.write = orig;
  }
  const out = chunks.join("");
  assert.equal(code, 0);
  // meta header (our instructions to the agent)
  assert.match(out, /onboarding the CURRENT repository/);
  assert.match(out, /npx -y @erzhe\/harness-kit@latest/);
  // skill body (proves the file was found and appended)
  assert.match(out, /erzhe-harness-init/);
  assert.match(out, /\.agents\/manifest\.yaml/);
});

test("check-loop prints the two-gate loop and durable evidence guidance", () => {
  const orig = process.stdout.write;
  const chunks: string[] = [];
  process.stdout.write = ((s: string | Uint8Array): boolean => {
    chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = checkLoopCmd();
  } finally {
    process.stdout.write = orig;
  }
  const out = chunks.join("");
  assert.equal(code, 0);
  assert.match(out, /run-checks \+ verify/);
  assert.match(out, /harness-kit evidence/);
  assert.match(out, /--where <输出中的 scope>/);
});
