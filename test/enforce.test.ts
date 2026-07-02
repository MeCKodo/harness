import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEnforcement } from "../src/enforce";

function tmpRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "harness-enforce-"));
  mkdirSync(join(d, "src"), { recursive: true });
  return d;
}

test("forbid_pattern flags matching line with correct file:line", () => {
  const repo = tmpRepo();
  writeFileSync(join(repo, "src/bad.ts"), "const x = 1;\nconsole.log(x);\n");
  writeFileSync(join(repo, "src/good.ts"), "export const y = 2;\n");
  const v = runEnforcement(repo, "no-console", {
    forbid_pattern: ["console\\.log\\("],
    path_glob: ["src/**"],
  });
  assert.equal(v.length, 1);
  assert.equal(v[0].file, "src/bad.ts");
  assert.equal(v[0].line, 2);
});

test("clean repo yields no violations", () => {
  const repo = tmpRepo();
  writeFileSync(join(repo, "src/good.ts"), "export const y = 2;\n");
  const v = runEnforcement(repo, "no-console", {
    forbid_pattern: ["console\\.log\\("],
    path_glob: ["src/**"],
  });
  assert.equal(v.length, 0);
});

test("require_pattern flags when the required pattern is absent in scope", () => {
  const repo = tmpRepo();
  writeFileSync(join(repo, "src/a.ts"), "export const y = 2;\n");
  const v = runEnforcement(repo, "need-license", {
    require_pattern: ["@license"],
    path_glob: ["src/**"],
  });
  assert.equal(v.length, 1);
  assert.match(v[0].reason, /required pattern/);
});

test("path_glob scopes the check (out-of-scope files are ignored)", () => {
  const repo = tmpRepo();
  mkdirSync(join(repo, "scripts"), { recursive: true });
  writeFileSync(join(repo, "scripts/dev.sh"), "echo console.log(\n");
  const v = runEnforcement(repo, "no-console", {
    forbid_pattern: ["console\\.log\\("],
    path_glob: ["src/**"],
  });
  assert.equal(v.length, 0);
});
