import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { inspectManagedFiles, writeManagedFiles } from "../src/managed-files";

function fixture(prefix = "hk-managed-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function transactionArtifacts(repo: string): string[] {
  return readdirSync(repo).filter((name) => name.includes(".harness-kit-"));
}

test("preserves the relative CLAUDE.md -> AGENTS.md semantic alias", () => {
  const repo = fixture();
  writeFileSync(join(repo, "AGENTS.md"), "old agents\n");
  symlinkSync("AGENTS.md", join(repo, "CLAUDE.md"));
  const targets = [
    ["AGENTS.md", "new agents\n"],
    ["CLAUDE.md", "generated claude\n"],
  ] as const;

  const inspections = inspectManagedFiles(repo, targets);
  assert.equal(inspections[0].kind, "regular");
  assert.equal(inspections[0].currentContent, "old agents\n");
  assert.equal(inspections[1].kind, "allowed-alias");
  assert.equal(inspections[1].linkTarget, "AGENTS.md");
  assert.equal(inspections[1].satisfiesDesired, true);

  const result = writeManagedFiles(repo, targets);

  assert.equal(readFileSync(join(repo, "AGENTS.md"), "utf8"), "new agents\n");
  assert.equal(lstatSync(join(repo, "CLAUDE.md")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(repo, "CLAUDE.md")), "AGENTS.md");
  assert.deepEqual(result.written, ["AGENTS.md"]);
  assert.deepEqual(result.preservedAliases, ["CLAUDE.md"]);
});

test("rejects every final-component symlink except the semantic alias", () => {
  const repo = fixture();
  writeFileSync(join(repo, "AGENTS.md"), "original\n");
  writeFileSync(join(repo, "elsewhere.md"), "outside target\n");
  symlinkSync("elsewhere.md", join(repo, "CLAUDE.md"));

  assert.throws(
    () =>
      writeManagedFiles(repo, [
        ["AGENTS.md", "replacement\n"],
        ["CLAUDE.md", "generated claude\n"],
      ]),
    /CLAUDE\.md.*symlink/i,
  );
  assert.equal(readFileSync(join(repo, "AGENTS.md"), "utf8"), "original\n");
  assert.equal(readFileSync(join(repo, "elsewhere.md"), "utf8"), "outside target\n");
  assert.equal(readlinkSync(join(repo, "CLAUDE.md")), "elsewhere.md");
});

test("rejects a generated target whose parent symlink resolves outside the repository", () => {
  const repo = fixture();
  const outside = fixture("hk-managed-outside-");
  symlinkSync(outside, join(repo, "escaped"));

  assert.throws(() => writeManagedFiles(repo, [["escaped/generated.md", "nope\n"]]), /parent.*outside/i);
  assert.equal(existsSync(join(outside, "generated.md")), false);
});

test("rejects a generated target through an in-repository parent symlink", () => {
  const repo = fixture();
  mkdirSync(join(repo, "real-parent"));
  symlinkSync("real-parent", join(repo, "alias-parent"));

  assert.throws(
    () => writeManagedFiles(repo, [["alias-parent/generated.md", "nope\n"]]),
    /parent.*must not be a symlink/i,
  );
  assert.equal(existsSync(join(repo, "real-parent/generated.md")), false);
});

test("preflights the complete target set before writing any destination", () => {
  const repo = fixture();
  mkdirSync(join(repo, "blocked.md"));

  assert.throws(
    () =>
      writeManagedFiles(repo, [
        ["first.md", "must never appear\n"],
        ["blocked.md", "cannot replace a directory\n"],
      ]),
    /blocked\.md.*directory/i,
  );
  assert.equal(existsSync(join(repo, "first.md")), false);
  assert.deepEqual(transactionArtifacts(repo), []);
});

test("replaces a regular target by displacing the original and no-replace linking the staged file", () => {
  const repo = fixture();
  const canonicalRepo = realpathSync(repo);
  const target = join(canonicalRepo, "AGENTS.md");
  writeFileSync(target, "before\n");
  const beforeInode = lstatSync(target).ino;
  const renameCalls: Array<{ from: string; to: string }> = [];
  const linkCalls: Array<{ from: string; to: string }> = [];

  writeManagedFiles(repo, [["AGENTS.md", "after\n"]], {
    rename(from, to) {
      renameCalls.push({ from, to });
      renameSync(from, to);
    },
    link(from, to) {
      linkCalls.push({ from, to });
      linkSync(from, to);
    },
  });

  assert.equal(readFileSync(target, "utf8"), "after\n");
  assert.notEqual(lstatSync(target).ino, beforeInode);
  assert.ok(
    renameCalls.some(
      ({ from, to }) => from === target && join(canonicalRepo, basename(to)) === to && to.includes(".harness-kit-"),
    ),
  );
  assert.ok(
    linkCalls.some(
      ({ from, to }) => join(canonicalRepo, basename(from)) === from && from.includes(".harness-kit-") && to === target,
    ),
  );
  assert.deepEqual(transactionArtifacts(repo), []);
});

test("an already-current regular target is not rewritten", () => {
  const repo = fixture();
  const target = join(realpathSync(repo), "AGENTS.md");
  writeFileSync(target, "current\n");
  const beforeInode = lstatSync(target).ino;
  let renamed = false;

  const result = writeManagedFiles(repo, [["AGENTS.md", "current\n"]], {
    rename(from, to) {
      renamed = true;
      renameSync(from, to);
    },
  });

  assert.equal(renamed, false);
  assert.equal(lstatSync(target).ino, beforeInode);
  assert.deepEqual(result.written, []);
  assert.deepEqual(transactionArtifacts(repo), []);
});

test("authorization runs after full preflight and before any staging or destination write", () => {
  const repo = fixture();
  writeFileSync(join(repo, "AGENTS.md"), "legacy\n");
  let inspected = 0;

  assert.throws(
    () =>
      writeManagedFiles(repo, [["AGENTS.md", "generated\n"]], {
        authorize(inspections) {
          inspected = inspections.length;
          throw new Error("takeover not authorized");
        },
      }),
    /takeover not authorized/,
  );
  assert.equal(inspected, 1);
  assert.equal(readFileSync(join(repo, "AGENTS.md"), "utf8"), "legacy\n");
  assert.deepEqual(transactionArtifacts(repo), []);
});

test("rolls back already-replaced targets when a later no-replace install fails", () => {
  const repo = fixture();
  const canonicalRepo = realpathSync(repo);
  const first = join(canonicalRepo, "AGENTS.md");
  const second = join(canonicalRepo, "OTHER.md");
  writeFileSync(first, "agents before\n");
  writeFileSync(second, "other before\n");
  let destinationLink = 0;

  assert.throws(
    () =>
      writeManagedFiles(
        repo,
        [
          ["AGENTS.md", "agents after\n"],
          ["OTHER.md", "other after\n"],
        ],
        {
          link(from, to) {
            if (to === first || to === second) {
              destinationLink += 1;
              if (destinationLink === 2) throw new Error("injected second commit failure");
            }
            linkSync(from, to);
          },
        },
      ),
    /injected second commit failure/,
  );

  assert.equal(readFileSync(first, "utf8"), "agents before\n");
  assert.equal(readFileSync(second, "utf8"), "other before\n");
  assert.deepEqual(transactionArtifacts(repo), []);
});

test("a regular target updated during commit is restored with the newer bytes", () => {
  const repo = fixture();
  const target = join(realpathSync(repo), "AGENTS.md");
  writeFileSync(target, "preflight owner\n");

  assert.throws(
    () =>
      writeManagedFiles(repo, [["AGENTS.md", "generated\n"]], {
        rename(from, to) {
          if (from === target) writeFileSync(target, "concurrent owner\n");
          renameSync(from, to);
        },
      }),
    /changed during commit/,
  );

  assert.equal(readFileSync(target, "utf8"), "concurrent owner\n");
  assert.deepEqual(transactionArtifacts(repo), []);
});

test("a target that appears after preflight is preserved instead of overwritten or rolled back", () => {
  const repo = fixture();
  const target = join(realpathSync(repo), "appeared.md");

  assert.throws(
    () =>
      writeManagedFiles(repo, [["appeared.md", "generated\n"]], {
        link(from, to) {
          writeFileSync(to, "concurrent owner\n");
          linkSync(from, to);
        },
      }),
    /EEXIST/,
  );

  assert.equal(readFileSync(target, "utf8"), "concurrent owner\n");
  assert.deepEqual(transactionArtifacts(repo), []);
});
