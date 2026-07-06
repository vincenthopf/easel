import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Config } from "@oclif/core";

const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;
const TIMEOUT_MS = 2_000;
const UPDATE_URL = "https://registry.npmjs.org/@vincenthopf%2Feasel/latest";

interface UpdateCache {
  checkedAt?: number;
  latest?: string;
}

interface RegistryLatest {
  version?: unknown;
}

export function startUpdateCheck(config: Config): void {
  const cache = readCache(config.cacheDir);
  const latest = typeof cache.latest === "string" ? cache.latest : undefined;
  const checkedAt = typeof cache.checkedAt === "number" ? cache.checkedAt : 0;

  if (latest && versionGreater(latest, config.version)) printUpdate(latest, config.version);
  if (Date.now() - checkedAt < CHECK_EVERY_MS) return;

  void refreshLatest(config).catch(() => {
    // Best-effort only.
  });
}

async function refreshLatest(config: Config): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(UPDATE_URL, { method: "GET", signal: controller.signal });
    if (!response.ok) return;

    const body = (await response.json()) as RegistryLatest;
    if (typeof body.version !== "string") return;

    writeCache(config.cacheDir, { checkedAt: Date.now(), latest: body.version });
    if (versionGreater(body.version, config.version)) printUpdate(body.version, config.version);
  } catch {
    // Network and parse failures are silent.
  } finally {
    clearTimeout(timeout);
  }
}

function readCache(cacheDir: string): UpdateCache {
  try {
    const path = cachePath(cacheDir);
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as UpdateCache;
  } catch {
    return {};
  }
}

function writeCache(cacheDir: string, cache: UpdateCache): void {
  try {
    writeFileSync(cachePath(cacheDir), `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Cache is an optimisation only.
  }
}

function cachePath(cacheDir: string): string {
  return join(cacheDir, "update-check.json");
}

function printUpdate(latest: string, current: string): void {
  console.error(
    `easel ${latest} is available (you have ${current}). Agents: update with \`npm install -g @vincenthopf/easel@latest\`.`,
  );
}

function versionGreater(left: string, right: string): boolean {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return false;

  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

function parseVersion(value: string): [number, number, number] | undefined {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
