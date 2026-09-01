import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Config } from "./config.js";
import { PublicHttpClient } from "./http.js";
import { atomicWriteFileSync } from "./storage.js";

const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;
const UPDATE_URL = "https://registry.npmjs.org/@vincenthopf%2feasel/latest";

interface UpdateCache {
  checkedAt?: number;
  latest?: string;
}

interface RegistryLatest {
  version?: unknown;
}

export function startUpdateCheck(
  config: Config,
  currentVersion: string,
  options: { jsonRequested?: boolean; environment?: Record<string, string | undefined>; interactive?: boolean } = {},
): void {
  const environment = options.environment ?? process.env;
  const interactive = options.interactive ?? Boolean(process.stderr.isTTY);
  if (!interactive || options.jsonRequested || environment.CI || truthy(environment.EASEL_NO_UPDATE_CHECK)) return;
  const cache = readCache(config.cacheDir);
  if (typeof cache.latest === "string" && versionGreater(cache.latest, currentVersion)) printUpdate(cache.latest, currentVersion);
  if (Date.now() - (cache.checkedAt ?? 0) < CHECK_EVERY_MS) return;
  void refreshLatest(config, currentVersion).catch(() => undefined);
}

export function versionGreater(left: string, right: string): boolean {
  const first = parseVersion(left);
  const second = parseVersion(right);
  if (!first || !second) return false;
  for (let index = 0; index < 3; index += 1) {
    const difference = first.core[index]! - second.core[index]!;
    if (difference !== 0) return difference > 0;
  }
  if (first.prerelease.length === 0 && second.prerelease.length > 0) return true;
  if (first.prerelease.length > 0 && second.prerelease.length === 0) return false;
  const length = Math.max(first.prerelease.length, second.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = first.prerelease[index];
    const b = second.prerelease[index];
    if (a === undefined) return false;
    if (b === undefined) return true;
    if (a === b) continue;
    const aNumber = /^\d+$/.test(a) ? Number(a) : undefined;
    const bNumber = /^\d+$/.test(b) ? Number(b) : undefined;
    if (aNumber !== undefined && bNumber !== undefined) return aNumber > bNumber;
    if (aNumber !== undefined) return false;
    if (bNumber !== undefined) return true;
    return a.localeCompare(b) > 0;
  }
  return false;
}

async function refreshLatest(config: Config, currentVersion: string): Promise<void> {
  let latest: string | undefined;
  try {
    const http = new PublicHttpClient(
      { ...config, requestTimeoutMs: Math.min(config.requestTimeoutMs, 2_000), retryLimit: 0 },
      { allowAnyHttpsOrigin: true, useRateLimiter: false },
    );
    const response = await http.getJson<RegistryLatest>(UPDATE_URL, { maxBytes: 64 * 1024 });
    if (typeof response.data.version === "string") latest = response.data.version;
  } finally {
    writeCache(config.cacheDir, { checkedAt: Date.now(), latest });
  }
  if (latest && versionGreater(latest, currentVersion)) printUpdate(latest, currentVersion);
}

function readCache(directory: string): UpdateCache {
  try {
    const path = cachePath(directory);
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as UpdateCache;
  } catch {
    return {};
  }
}

function writeCache(directory: string, cache: UpdateCache): void {
  try {
    atomicWriteFileSync(cachePath(directory), `${JSON.stringify(cache, null, 2)}\n`);
  } catch {
    return;
  }
}

function cachePath(directory: string): string {
  return join(directory, "update-check.json");
}

function printUpdate(latest: string, current: string): void {
  console.error(`easel ${latest} is available (you have ${current}). Update with \`npm install -g @vincenthopf/easel@${latest}\`.`);
}

function parseVersion(value: string): { core: [number, number, number]; prerelease: string[] } | undefined {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

function truthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? "");
}
