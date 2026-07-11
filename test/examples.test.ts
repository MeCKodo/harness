import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { doctorCmd } from "../src/commands/doctor";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

for (const name of ["cli-tool", "demo-run", "frontend-spa", "npm-lib"]) {
  test(`example ${name} stays doctor-healthy`, () => {
    const original = process.stdout.write.bind(process.stdout);
    const chunks: string[] = [];
    (process.stdout as unknown as { write: (chunk: string | Uint8Array) => boolean }).write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    let code: number;
    try {
      code = doctorCmd(join(ROOT, "examples", name));
    } finally {
      (process.stdout as unknown as { write: typeof process.stdout.write }).write = original;
    }
    assert.equal(code, 0, chunks.join(""));
  });
}
