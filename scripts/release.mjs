import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE = "@sd-softdev/opencode-codex-contingent";
const REPOSITORY = "https://github.com/sd-softdev/opencode-codex-contingent";
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const directory = ".release";

export function validateTag(tag, version) {
  if (typeof tag !== "string" || !TAG.test(tag)) {
    throw new Error("Release tags must have the stable SemVer form vX.Y.Z.");
  }
  if (tag.slice(1) !== version) throw new Error("Tag and package.json version do not match.");
  return version;
}

export function integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export class RetryableRegistryError extends Error {
  constructor(message, retryAfterMs = 0) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

async function registryRequest(url, timeoutMs, fetcher) {
  let response;
  try {
    response = await fetcher(url, {
      signal: AbortSignal.timeout(timeoutMs), cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
  } catch (error) {
    if (["TypeError", "TimeoutError", "AbortError"].includes(error?.name)) {
      throw new RetryableRegistryError("Temporary npm registry connection failure.");
    }
    throw error;
  }
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    const retryAfter = response.headers.get("retry-after");
    const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter)
      ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter ?? "") - Date.now()) || 0;
    throw new RetryableRegistryError(`Temporary npm registry response (HTTP ${response.status}).`, retryAfterMs);
  }
  return response;
}

export async function registryVersion(name, version, fetcher = fetch) {
  const response = await registryRequest(`https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}`, 10000, fetcher);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`npm metadata request failed (HTTP ${response.status}).`);
  try {
    return await response.json();
  } catch (error) {
    if (["TypeError", "TimeoutError", "AbortError"].includes(error?.name)) {
      throw new RetryableRegistryError("Temporary npm metadata connection failure.");
    }
    throw error;
  }
}

export function assertMetadata(metadata, artifact) {
  if (metadata.name !== artifact.name || metadata.version !== artifact.version
    || metadata.dist?.integrity !== artifact.integrity) {
    throw new Error("Published npm version does not match the prepared artifact. Never overwrite a release; use a new version.");
  }
}

export async function verifyPublished(artifact, {
  fetcher = fetch, attempts = 41, timeoutMs = 600000, intervalMs = 15000,
  now = Date.now, wait = (delay) => new Promise((done) => setTimeout(done, delay)),
  onRetry = () => {},
} = {}) {
  const started = now();
  let reason = "npm version is not visible yet (HTTP 404).";
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0 && now() - started >= timeoutMs) break;
    let retryAfterMs = 0;
    try {
      const metadata = await registryVersion(artifact.name, artifact.version, fetcher);
      if (metadata) {
        assertMetadata(metadata, artifact);
        const url = new URL(metadata.dist.tarball);
        if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org") {
          throw new Error("Unexpected npm tarball host.");
        }
        const response = await registryRequest(url, 15000, fetcher);
        if (response.status === 404) throw new RetryableRegistryError("npm tarball is not visible yet (HTTP 404).");
        if (!response.ok) throw new Error(`npm tarball download failed (HTTP ${response.status}).`);
        let bytes;
        try {
          bytes = Buffer.from(await response.arrayBuffer());
        } catch (error) {
          if (["TypeError", "TimeoutError", "AbortError"].includes(error?.name)) {
            throw new RetryableRegistryError("Temporary npm tarball connection failure.");
          }
          throw error;
        }
        if (integrity(bytes) !== artifact.integrity) throw new Error("Downloaded npm tarball failed integrity verification.");
        return;
      }
      reason = "npm version is not visible yet (HTTP 404).";
    } catch (error) {
      // Identity and integrity mismatches are never retried or downgraded.
      if (!(error instanceof RetryableRegistryError)) throw error;
      reason = error.message;
      retryAfterMs = error.retryAfterMs;
    }
    const remaining = timeoutMs - (now() - started);
    if (attempt + 1 >= attempts || remaining <= 0) break;
    const delayMs = Math.min(Math.max(intervalMs, retryAfterMs), remaining);
    onRetry({ attempt: attempt + 1, attempts, elapsedMs: now() - started, delayMs, reason });
    await wait(delayMs);
  }
  throw new Error(`npm version is not visible or downloadable after verification retries. ${reason} The package may already be published; rerun the failed workflow once npm processing completes. Do not republish or move the tag.`);
}

export function previousTag(tags, current) {
  return tags.split("\n").find((tag) => TAG.test(tag) && tag !== current);
}

export function parseCommit(hash, message) {
  const [subject, ...body] = message.trim().split(/\r?\n/);
  const match = /^(\w+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/.exec(subject);
  const breakingBody = body.join("\n").match(/(?:^|\n)BREAKING[ -]CHANGE:\s*([^\n]+(?:\n(?![A-Za-z-]+:).+)*)/);
  return {
    hash, type: match?.[1] ?? "other", scope: match?.[2],
    description: match?.[4] ?? subject,
    breaking: Boolean(match?.[3] || breakingBody),
    breakingDescription: breakingBody?.[1].trim(),
  };
}

export function releaseNotes(tag, commits, previous) {
  const lines = [`# ${tag}`, "", `npm: [${PACKAGE}@${tag.slice(1)}](https://www.npmjs.com/package/${PACKAGE}/v/${tag.slice(1)})`, ""];
  const entry = (commit) => `- ${commit.scope ? `**${commit.scope}:** ` : ""}${commit.description} ([${commit.hash.slice(0, 7)}](${REPOSITORY}/commit/${commit.hash}))`;
  const breaking = commits.filter((commit) => commit.breaking);
  if (breaking.length) {
    lines.push("## Breaking changes", "", ...breaking.map((commit) => `${entry(commit)}${commit.breakingDescription ? ` — ${commit.breakingDescription}` : ""}`), "");
  }
  const headings = {
    feat: "Features", fix: "Fixes", perf: "Performance", refactor: "Refactoring",
    docs: "Documentation", build: "Build", ci: "CI", test: "Tests", chore: "Maintenance", other: "Other changes",
  };
  for (const [type, heading] of Object.entries(headings)) {
    const matching = commits.filter((commit) => (Object.hasOwn(headings, commit.type) ? commit.type : "other") === type);
    if (matching.length) lines.push(`## ${heading}`, "", ...matching.map(entry), "");
  }
  if (!commits.length) lines.push("No commits in this release range.", "");
  if (previous) lines.push(`[Full changelog](${REPOSITORY}/compare/${previous}...${tag})`, "");
  return lines.join("\n");
}

async function manifest() {
  const artifact = JSON.parse(await readFile(`${directory}/artifact.json`, "utf8"));
  validateTag(artifact.tag, artifact.version);
  if (artifact.name !== PACKAGE || basename(artifact.filename) !== artifact.filename) throw new Error("Invalid release manifest.");
  if (integrity(await readFile(`${directory}/${artifact.filename}`)) !== artifact.integrity) throw new Error("Local release artifact changed.");
  return artifact;
}

async function main(command, tag = process.env.GITHUB_REF_NAME) {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  if (pkg.name !== PACKAGE) throw new Error("Unexpected package scope.");
  validateTag(tag, pkg.version);
  if (command === "validate") return;
  if (command === "prepare") {
    await mkdir(directory, { recursive: true });
    const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", directory], { encoding: "utf8" }));
    const expected = ["LICENSE", "README.md", "SECURITY.md", "package.json", "docs/preview.svg", "dist/quota.mjs", "dist/tui.js"].sort();
    if (JSON.stringify(packed.files.map((file) => file.path).sort()) !== JSON.stringify(expected)) throw new Error("Unexpected files in npm package.");
    const artifact = { name: pkg.name, version: pkg.version, tag, filename: packed.filename, integrity: packed.integrity };
    if (integrity(await readFile(`${directory}/${artifact.filename}`)) !== artifact.integrity) throw new Error("Packed artifact integrity mismatch.");
    await writeFile(`${directory}/artifact.json`, `${JSON.stringify(artifact, null, 2)}\n`);
    return;
  }
  const artifact = await manifest();
  if (artifact.tag !== tag) throw new Error("Prepared artifact belongs to a different tag.");
  if (command === "publish") {
    const existing = await registryVersion(artifact.name, artifact.version);
    if (existing) {
      assertMetadata(existing, artifact);
      console.log("Identical npm version already exists; proceeding to verification.");
    } else {
      execFileSync("npm", ["publish", `${directory}/${artifact.filename}`, "--access", "public", "--tag", "latest", "--registry", "https://registry.npmjs.org/", "--ignore-scripts"], { stdio: "inherit" });
    }
  } else if (command === "verify") {
    await verifyPublished(artifact, { onRetry: ({ attempt, attempts, elapsedMs, delayMs, reason }) => {
      console.log(`npm verification ${attempt}/${attempts}, ${Math.round(elapsedMs / 1000)}s elapsed: ${reason} Retrying in ${Math.ceil(delayMs / 1000)}s.`);
    } });
    console.log("Published version and downloaded tarball integrity verified.");
  } else if (command === "notes") {
    const tags = execFileSync("git", ["tag", "--merged", tag, "--sort=-version:refname"], { encoding: "utf8" });
    const previous = previousTag(tags, tag);
    const range = previous ? `${previous}..${tag}` : tag;
    const log = execFileSync("git", ["log", "--reverse", "--format=%H%x00%B%x00", range], { encoding: "utf8" }).split("\0");
    const commits = [];
    for (let index = 0; index + 1 < log.length; index += 2) {
      commits.push(parseCommit(log[index].trim(), log[index + 1]));
    }
    await writeFile(`${directory}/notes.md`, releaseNotes(tag, commits, previous));
  } else {
    throw new Error("Expected validate, prepare, publish, verify, or notes.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2], process.argv[3]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
