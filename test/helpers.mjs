import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "easel-test-"));
  const cwd = join(root, "project");
  const config = join(root, "config");
  const cache = join(root, "cache");
  await Promise.all([mkdir(cwd), mkdir(config), mkdir(cache)]);
  return {
    root,
    cwd,
    config,
    cache,
    env: {
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      EASEL_MIN_INTERVAL: "0.001",
      EASEL_MAX_INTERVAL: "0.001",
      EASEL_RPM: "10000",
      EASEL_REQUEST_TIMEOUT_MS: "500",
      EASEL_RETRY_LIMIT: "0",
      EASEL_ALLOW_INSECURE_LOCALHOST: "1",
    },
    async writeUserEnv(values) {
      const directory = join(config, "easel");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, ".env"), serialize(values), { mode: 0o600 });
    },
    async writeProjectEnv(values) {
      await writeFile(join(cwd, ".env"), serialize(values), { mode: 0o600 });
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function serialize(values) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

export function configFixture(baseUrl, overrides = {}) {
  return {
    baseUrl,
    canvasOrigin: new URL(baseUrl).origin,
    token: "test-token",
    libraryBaseUrl: "",
    minInterval: 0.001,
    maxInterval: 0.001,
    rpm: 10000,
    cacheDir: overrides.cacheDir ?? "/tmp/easel-test-cache",
    configDir: overrides.configDir ?? "/tmp/easel-test-config",
    configSource: { kind: "environment" },
    requestTimeoutMs: 500,
    retryLimit: 0,
    maxRedirects: 4,
    maxPages: 10,
    maxItems: 100,
    maxResponseBytes: 1_000_000,
    maxDownloadBytes: 1_000_000,
    lockTimeoutMs: 200,
    allowInsecureLocalhost: true,
    ...overrides,
  };
}

export async function mockServer(handler) {
  const instance = createServer(handler);
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    async close() {
      await new Promise((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
    },
  };
}
