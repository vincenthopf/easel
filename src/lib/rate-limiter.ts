import { closeSync, existsSync, openSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Config } from "./config.js";
import { canvasStateNamespace } from "./config.js";
import { UserError } from "./errors.js";
import { ensurePrivateDirectory, readJsonFile, writeJsonFileSync } from "./storage.js";

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

export class RateLimitLockError extends UserError {}

export class RateLimiter {
  readonly statePath: string;
  private readonly lockPath: string;
  private lastWaitMs = 0;

  constructor(private readonly config: Config, namespace = canvasStateNamespace(config)) {
    const directory = join(config.cacheDir, "canvas", namespace);
    ensurePrivateDirectory(directory);
    this.statePath = join(directory, "rate-state.json");
    this.lockPath = join(directory, "rate-state.lock");
  }

  async beforeRequest(signal?: AbortSignal): Promise<RateLimitInfo> {
    let totalWaitMs = 0;
    for (;;) {
      const waitMs = await withLock(this.lockPath, this.config.lockTimeoutMs, signal, () => {
        const now = Date.now();
        const state = readState(this.statePath);
        const recent = state.recent.filter((time) => now - time < 60_000).sort((left, right) => left - right);
        const gap = randomGap(this.config.minInterval, this.config.maxInterval);
        const gapWait = Math.max(0, state.lastRequestAt + gap - now);
        const rpmWait = recent.length >= this.config.rpm ? Math.max(0, recent[0]! + 60_000 - now) : 0;
        const needed = Math.ceil(Math.max(gapWait, rpmWait));
        if (needed <= 0) {
          recent.push(now);
          writeJsonFileSync(this.statePath, { recent, lastRequestAt: now });
        }
        return needed;
      });
      if (waitMs <= 0) break;
      totalWaitMs += waitMs;
      await sleep(waitMs, signal);
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

  async backoff(attempt: number, signal?: AbortSignal): Promise<void> {
    const ceiling = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
    await sleep(ceiling / 2 + Math.random() * (ceiling / 2), signal);
  }
}

async function withLock<T>(
  lockPath: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  action: () => T | Promise<T>,
): Promise<T> {
  ensurePrivateDirectory(dirname(lockPath));
  const startedAt = Date.now();
  const staleMs = Math.max(30_000, timeoutMs * 2);

  for (;;) {
    throwIfAborted(signal);
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      try {
        return await action();
      } finally {
        closeSync(descriptor);
        try {
          unlinkSync(lockPath);
        } catch {
          undefined;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stats = statSync(lockPath);
        if (Date.now() - stats.mtimeMs > staleMs) unlinkSync(lockPath);
      } catch {
        if (!existsSync(lockPath)) continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new RateLimitLockError(`Timed out waiting for Easel rate-limit state at ${lockPath}.`);
      }
      await sleep(50 + Math.random() * 75, signal);
    }
  }
}

function readState(path: string): RateState {
  const value = readJsonFile<Partial<RateState>>(path);
  return {
    recent: Array.isArray(value?.recent) ? value.recent.filter((item): item is number => Number.isFinite(item)) : [],
    lastRequestAt: Number.isFinite(value?.lastRequestAt) ? Number(value?.lastRequestAt) : 0,
  };
}

function randomGap(minSeconds: number, maxSeconds: number): number {
  const minimum = Math.max(0, minSeconds) * 1000;
  const maximum = Math.max(minimum, maxSeconds * 1000);
  return minimum + Math.random() * (maximum - minimum);
}

export function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    };
    function finish() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}
