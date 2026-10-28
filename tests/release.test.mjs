import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  PACKAGE, assertMetadata, integrity, parseCommit, previousTag,
  registryVersion, releaseNotes, validateTag, verifyPublished,
} from "../scripts/release.mjs";

const bytes = Buffer.from("fictional release artifact");
const artifact = { name: PACKAGE, version: "1.2.3", integrity: integrity(bytes) };
const metadata = { ...artifact, dist: {
  integrity: artifact.integrity,
  tarball: "https://registry.npmjs.org/@sd-softdev/opencode-codex-contingent/-/example.tgz",
} };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test("accepts only stable matching release tags", () => {
  assert.equal(validateTag("v1.2.3", "1.2.3"), "1.2.3");
  assert.equal(validateTag("v0.0.0", "0.0.0"), "0.0.0");
  for (const tag of [undefined, "1.2.3", "v1.2", "v1.2.3-beta.1", "v01.2.3", "v1.2.3;echo unexpected"]) {
    assert.throws(() => validateTag(tag, "1.2.3"));
  }
  assert.throws(() => validateTag("v1.2.3", "1.2.4"), /do not match/);
});

test("chooses the previous stable tag from the version-sorted reachable tags", () => {
  assert.equal(previousTag("v1.2.3\nv1.2.3-beta.1\nother\nv1.2.2\nv1.1.0\n", "v1.2.3"), "v1.2.2");
  assert.equal(previousTag("v0.1.0\n", "v0.1.0"), undefined);
});

test("parses scopes and both breaking-change conventions", () => {
  const scoped = parseCommit("a".repeat(40), "feat(ui)!: change sidebar\n\nBREAKING CHANGE: old options were removed");
  assert.equal(scoped.type, "feat");
  assert.equal(scoped.scope, "ui");
  assert.equal(scoped.description, "change sidebar");
  assert.equal(scoped.breaking, true);
  assert.equal(scoped.breakingDescription, "old options were removed");
  assert.equal(parseCommit("b", "fix: migrate config\n\nBREAKING-CHANGE: config changed").breaking, true);
  assert.equal(parseCommit("c", "feat!: rename command").breaking, true);
  assert.equal(parseCommit("d", "fix(cli): handle ENOENT").breaking, false);
});

test("groups Conventional Commits, preserves unknown messages, and links comparisons", () => {
  const commits = [
    parseCommit("a".repeat(40), "feat(ui): add quota"),
    parseCommit("b".repeat(40), "fix!: change command"),
    parseCommit("c".repeat(40), "custom: update something"),
    parseCommit("d".repeat(40), "Merge a change"),
  ];
  const notes = releaseNotes("v1.2.3", commits, "v1.2.2");
  for (const expected of ["## Features", "## Fixes", "## Breaking changes", "## Other changes", "**ui:** add quota", "update something", "Merge a change", "compare/v1.2.2...v1.2.3"]) {
    assert.ok(notes.includes(expected), expected);
  }
  assert.ok(notes.includes(`${PACKAGE}@1.2.3`));
});

test("initial and empty releases do not invent a previous comparison", () => {
  const first = releaseNotes("v0.1.0", [parseCommit("a".repeat(40), "feat: initial plugin")]);
  assert.match(first, /initial plugin/);
  assert.ok(!first.includes("/compare/"));
  assert.match(releaseNotes("v0.1.1", [], "v0.1.0"), /No commits/);
});

test("metadata requests target the explicit public scoped registry version", async () => {
  let requested;
  const result = await registryVersion(PACKAGE, "1.2.3", async (url) => {
    requested = url;
    return json(metadata);
  });
  assert.equal(requested, "https://registry.npmjs.org/@sd-softdev%2fopencode-codex-contingent/1.2.3");
  assert.equal(result.name, PACKAGE);
  assert.equal(await registryVersion(PACKAGE, "1.2.3", async () => json({}, 404)), null);
  await assert.rejects(registryVersion(PACKAGE, "1.2.3", async () => json({}, 503)), /HTTP 503/);
});

test("existing immutable versions must match name, version, and exact integrity", () => {
  assert.doesNotThrow(() => assertMetadata(metadata, artifact));
  for (const changed of [
    { ...metadata, name: "different-package" },
    { ...metadata, version: "9.9.9" },
    { ...metadata, dist: { ...metadata.dist, integrity: integrity(Buffer.from("other")) } },
  ]) assert.throws(() => assertMetadata(changed, artifact), /does not match/);
});

test("verification downloads and independently hashes the published tarball", async () => {
  const calls = [];
  await verifyPublished(artifact, { fetcher: async (url) => {
    calls.push(String(url));
    return calls.length === 1 ? json(metadata) : new Response(bytes);
  } });
  assert.equal(calls.length, 2);
  assert.equal(calls[1], metadata.dist.tarball);
});

test("verification retries not-yet-visible versions with bounded waits", async () => {
  let calls = 0;
  let waits = 0;
  await verifyPublished(artifact, {
    attempts: 2,
    wait: async () => { waits++; },
    fetcher: async () => {
      calls++;
      return calls === 1 ? json({}, 404) : calls === 2 ? json(metadata) : new Response(bytes);
    },
  });
  assert.equal(calls, 3);
  assert.equal(waits, 1);
  await assert.rejects(verifyPublished(artifact, {
    attempts: 2, wait: async () => {}, fetcher: async () => json({}, 404),
  }), /not visible/);
});

test("verification rejects corrupted downloads and unexpected tarball hosts", async () => {
  let calls = 0;
  await assert.rejects(verifyPublished(artifact, { fetcher: async () =>
    ++calls === 1 ? json(metadata) : new Response("different tarball"),
  }), /integrity verification/);
  await assert.rejects(verifyPublished(artifact, { fetcher: async () => json({
    ...metadata, dist: { ...metadata.dist, tarball: "https://example.invalid/artifact.tgz" },
  }) }), /Unexpected npm tarball host/);
});

test("verification does not report success for a failed tarball download", async () => {
  let calls = 0;
  await assert.rejects(verifyPublished(artifact, { fetcher: async () =>
    ++calls === 1 ? json(metadata) : new Response("unavailable", { status: 503 }),
  }), /download failed/);
});

test("notes CLI uses real Git ranges and excludes unrelated tags", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-release-test-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Release fixture", GIT_COMMITTER_NAME: "Release fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(cwd, "no-hooks")}`, ...args], { cwd, env, stdio: "pipe" });
  const script = fileURLToPath(new URL("../scripts/release.mjs", import.meta.url));
  const prepareFixture = async (version) => {
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: PACKAGE, version }));
    await writeFile(join(cwd, ".release/artifact.json"), JSON.stringify({
      ...artifact, version, tag: `v${version}`, filename: "fixture.tgz",
    }));
  };
  try {
    await mkdir(join(cwd, ".release"));
    await writeFile(join(cwd, ".release/fixture.tgz"), bytes);
    git("init", "--initial-branch=main");
    git("commit", "--allow-empty", "-m", "feat: first feature");
    git("tag", "v0.1.0");
    git("commit", "--allow-empty", "-m", "feat(ui): new sidebar");
    git("commit", "--allow-empty", "-m", "fix!: new command");
    git("tag", "v0.2.0");
    git("switch", "--orphan", "unrelated");
    git("commit", "--allow-empty", "-m", "feat: unrelated history");
    git("tag", "v9.9.9");
    git("switch", "main");

    await prepareFixture("0.2.0");
    execFileSync(process.execPath, [script, "notes", "v0.2.0"], { cwd, env });
    const notes = await readFile(join(cwd, ".release/notes.md"), "utf8");
    assert.match(notes, /new sidebar/);
    assert.match(notes, /new command/);
    assert.match(notes, /Breaking changes/);
    assert.match(notes, /compare\/v0\.1\.0\.\.\.v0\.2\.0/);
    assert.ok(!notes.includes("first feature"));
    assert.ok(!notes.includes("unrelated history"));
    assert.ok(!notes.includes("v9.9.9"));

    await prepareFixture("0.1.0");
    execFileSync(process.execPath, [script, "notes", "v0.1.0"], { cwd, env });
    const first = await readFile(join(cwd, ".release/notes.md"), "utf8");
    assert.match(first, /first feature/);
    assert.ok(!first.includes("/compare/"));
    assert.ok(!first.includes("new sidebar"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
