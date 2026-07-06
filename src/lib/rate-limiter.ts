import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Config } from "./config.js";

interface RateState {
  recent: number[];
  lastRequestAt: number;
}

export interface RateLimitInfo {
  waitedMs: number;
  rpm: number;
  minInterval: number;
  maxInterval: number;
  statePath: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function jitter(minSeconds: number, maxSeconds: number): number {
  const min = Math.max(0, minSeconds) * 1000;
  const max = Math.max(min, maxSeconds * 1000);
  return min + Math.random() * (max - min);
}

function readState(path: string): RateState {
  try {
    if (!existsSync(path)) return { recent: [], lastRequestAt: 0 };
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RateState>;
    return {
      recent: Array.isArray(raw.recent)
        ? raw.recent.filter((n) => Number.isFinite(n))
        : [],
      lastRequestAt: Number.isFinite(raw.lastRequestAt) ? Number(raw.lastRequestAt) : 0,
    };
  } catch {
    return { recent: [], lastRequestAt: 0 };
  }
}

function writeState(path: string, state: RateState): void {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function withLock<T>(lockPath: string, fn: () => T | Promise<T>): Promise<T> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const staleMs = 30_000;

  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        return await fn();
      } finally {
        closeSync(fd);
        try {
          unlinkSync(lockPath);
        } catch {
          // Another process may have cleaned up a stale lock; harmless.
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) unlinkSync(lockPath);
      } catch {
        // Lock vanished or is not removable; wait and retry.
      }
      await sleep(80 + Math.random() * 120);
    }
  }
}

export class RateLimiter {
  readonly statePath: string;
  private readonly lockPath: string;
  private lastWaitMs = 0;

  constructor(private readonly config: Config) {
    this.statePath = join(config.cacheDir, "rate-state.json");
    this.lockPath = join(config.cacheDir, "rate-state.lock");
  }

  async beforeRequest(): Promise<RateLimitInfo> {
    let waitMs = 0;
    let totalWaitMs = 0;

    for (;;) {
      waitMs = await withLock(this.lockPath, () => {
        const now = Date.now();
        const state = readState(this.statePath);
        const recent = state.recent.filter((t) => now - t < 60_000);
        const randomGap = jitter(this.config.minInterval, this.config.maxInterval);
        const gapWait = Math.max(0, state.lastRequestAt + randomGap - now);
        const rpmWait =
          recent.length >= this.config.rpm
            ? Math.max(0, recent[0]! + 60_000 - now)
            : 0;
        const needed = Math.ceil(Math.max(gapWait, rpmWait));

        if (needed <= 0) {
          recent.push(now);
          writeState(this.statePath, { recent, lastRequestAt: now });
        }

        return needed;
      });

      if (waitMs <= 0) break;
      totalWaitMs += waitMs;
      await sleep(waitMs);
    }

    this.lastWaitMs = totalWaitMs;
    return this.info();
  }

  info(): RateLimitInfo {
    return {
      waitedMs: this.lastWaitMs,
      rpm: this.config.rpm,
      minInterval: this.config.minInterval,
      maxInterval: this.config.maxInterval,
      statePath: this.statePath,
    };
  }

  async backoff(attempt: number): Promise<void> {
    const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
    await sleep(base / 2 + Math.random() * base);
  }
}
