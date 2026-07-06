/**
 * Configuration — token and base URLs from the environment or a gitignored .env.
 * Nothing is hard-coded; the token lives only in your environment.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  baseUrl: string;
  token: string;
  libraryBaseUrl: string;
  minInterval: number;
  maxInterval: number;
  rpm: number;
  cacheDir: string;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

function projectRoot(): string {
  // src/lib/config.ts -> repo root; dist/lib/config.js -> repo root.
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

function loadDotenv(): void {
  const candidates = [join(process.cwd(), ".env"), join(projectRoot(), ".env")];
  const seen = new Set<string>();

  for (const path of candidates) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (!existsSync(path)) continue;

    for (const raw of readFileSync(path, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const idx = line.indexOf("=");
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      // Real environment always wins over the .env file.
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
}

function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const dir = join(base, "easel");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function loadConfig(opts: { requireToken?: boolean } = {}): Config {
  const requireToken = opts.requireToken ?? true;
  loadDotenv();

  const baseUrl = (process.env.CANVAS_BASE_URL ?? "").replace(/\/+$/, "");
  const token = process.env.CANVAS_TOKEN ?? "";

  if (requireToken && !token) {
    throw new ConfigError(
      "No Canvas token found. Copy .env.example to .env and set CANVAS_TOKEN " +
        "(Canvas → Account → Settings → New Access Token).",
    );
  }
  if (requireToken && !baseUrl) {
    throw new ConfigError(
      "CANVAS_BASE_URL is not set (e.g. https://canvas.youruniversity.edu).",
    );
  }

  return {
    baseUrl,
    token,
    libraryBaseUrl: (
      process.env.LIBRARY_BASE_URL || ""
    ).replace(/\/+$/, ""),
    minInterval: num("EASEL_MIN_INTERVAL", 0.7),
    maxInterval: num("EASEL_MAX_INTERVAL", 1.8),
    rpm: Math.floor(num("EASEL_RPM", 40)),
    cacheDir: cacheDir(),
  };
}
