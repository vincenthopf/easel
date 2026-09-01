import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { LibraryClient } from "../dist/lib/library.js";
import { RateLimitLockError, RateLimiter } from "../dist/lib/rate-limiter.js";
import { startUpdateCheck, versionGreater } from "../dist/lib/update-check.js";
import { configFixture, mockServer, workspace } from "./helpers.mjs";

test("rate-limit state is scoped across origins and accounts", async () => {
  const place = await workspace();
  try {
    const one = new RateLimiter(configFixture("https://one.example", { cacheDir: place.cache, token: "one" }));
    const two = new RateLimiter(configFixture("https://two.example", { cacheDir: place.cache, token: "one" }));
    const three = new RateLimiter(configFixture("https://one.example", { cacheDir: place.cache, token: "two" }));
    assert.notEqual(one.statePath, two.statePath);
    assert.notEqual(one.statePath, three.statePath);
  } finally {
    await place.cleanup();
  }
});

test("rate-limit lock waits are bounded", async () => {
  const place = await workspace();
  try {
    const limiter = new RateLimiter(configFixture("https://one.example", { cacheDir: place.cache, lockTimeoutMs: 40 }));
    const lock = limiter.statePath.replace(/rate-state\.json$/, "rate-state.lock");
    await mkdir(dirname(lock), { recursive: true });
    await writeFile(lock, "locked");
    await assert.rejects(limiter.beforeRequest(), RateLimitLockError);
  } finally {
    await place.cleanup();
  }
});

test("generic library search sends no Canvas authorization and has no institution constants", async () => {
  let authorization;
  const place = await workspace();
  const server = await mockServer((request, response) => {
    authorization = request.headers.authorization;
    response.end('<a href="/guides/referencing">Referencing guide</a>');
  });
  try {
    const config = configFixture("http://localhost:9", { cacheDir: place.cache, libraryBaseUrl: server.baseUrl });
    const results = await new LibraryClient(config).search("referencing");
    assert.equal(results[0].title, "Referencing guide");
    assert.equal(authorization, undefined);
    const source = await readFile(new URL("../src/lib/library.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /search_source_id|fq=s:|821|267/);
  } finally {
    await Promise.all([server.close(), place.cleanup()]);
  }
});

test("semantic version comparison handles prereleases", () => {
  assert.equal(versionGreater("1.0.0", "1.0.0-beta.2"), true);
  assert.equal(versionGreater("1.0.0-beta.10", "1.0.0-beta.2"), true);
  assert.equal(versionGreater("1.0.0-beta.2", "1.0.0"), false);
  assert.equal(versionGreater("1.0.1", "1.0.0"), true);
  assert.equal(versionGreater("v1.0.0+build.2", "1.0.0+build.1"), false);
});

test("update checks are silent in JSON and non-interactive execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "easel-update-"));
  const config = configFixture("https://canvas.example", { cacheDir: root });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("unexpected fetch");
  };
  try {
    startUpdateCheck(config, "0.2.1", { jsonRequested: true, interactive: true });
    startUpdateCheck(config, "0.2.1", { jsonRequested: false, interactive: false });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
