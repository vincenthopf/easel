import { Buffer } from "node:buffer";
import { open, unlink } from "node:fs/promises";

import type { Config } from "./config.js";
import { UserError } from "./errors.js";
import { RateLimiter } from "./rate-limiter.js";
import { ensureDirectoryAsync } from "./storage.js";
import { dirname } from "node:path";

export interface HttpResult<T> {
  data: T;
  headers: Headers;
  url: string;
}

export interface DownloadResult {
  headers: Headers;
  url: string;
  bytes: number;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  maxBytes?: number;
}

export class HttpError extends UserError {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(status: number, url: string, message: string, body = "") {
    super(message, { exitCode: status >= 500 || status === 429 ? 2 : 1 });
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class OriginPolicyError extends UserError {}
export class RequestTimeoutError extends UserError {}
export class PaginationError extends UserError {}
export class ResponseTooLargeError extends UserError {}
export class DownloadTooLargeError extends UserError {}
export class InvalidResponseError extends UserError {}

interface ClientPolicy {
  authorization?: string;
  allowedOrigin?: string;
  allowAnyHttpsOrigin?: boolean;
  useRateLimiter?: boolean;
}

interface RawResult {
  response: Response;
  url: URL;
}

export class CanvasHttpClient {
  readonly limiter: RateLimiter;
  private readonly base: URL;
  private readonly apiBase: URL;
  private readonly core: BoundedHttpClient;

  constructor(readonly config: Config) {
    if (!config.baseUrl || !config.token) throw new OriginPolicyError("Canvas requests require a configured Canvas URL and token.");
    this.base = new URL(`${config.baseUrl.replace(/\/+$/, "")}/`);
    this.apiBase = new URL("api/v1/", this.base);
    this.limiter = new RateLimiter(config);
    this.core = new BoundedHttpClient(config, {
      authorization: `Bearer ${config.token}`,
      allowedOrigin: this.base.origin,
      useRateLimiter: true,
    }, this.limiter);
  }

  canvasUrl(pathOrUrl: string): string {
    const url = absoluteOrRelative(pathOrUrl, this.apiBase);
    validateCanvasUrl(url, this.base, this.config.allowInsecureLocalhost);
    return url.toString();
  }

  siteUrl(pathOrUrl: string): string {
    const url = absoluteOrRelative(pathOrUrl, this.base);
    validateCanvasUrl(url, this.base, this.config.allowInsecureLocalhost);
    return url.toString();
  }

  async getJson<T>(url: string, options: RequestOptions = {}): Promise<HttpResult<T>> {
    validateCanvasUrl(new URL(url), this.base, this.config.allowInsecureLocalhost);
    return this.core.getJson<T>(url, options);
  }

  async getText(url: string, options: RequestOptions = {}): Promise<HttpResult<string>> {
    validateCanvasUrl(new URL(url), this.base, this.config.allowInsecureLocalhost);
    return this.core.getText(url, options);
  }

  async getPaginated<T>(url: string, options: RequestOptions = {}): Promise<T[]> {
    let next: string | undefined = this.canvasUrl(url);
    const output: T[] = [];
    const visited = new Set<string>();
    let pages = 0;

    while (next) {
      const normalized = new URL(next).toString();
      if (visited.has(normalized)) throw new PaginationError(`Canvas pagination repeated ${sanitizeUrl(normalized)}.`);
      if (pages >= this.config.maxPages) {
        throw new PaginationError(`Canvas pagination exceeded ${this.config.maxPages} pages at ${sanitizeUrl(normalized)}.`);
      }
      visited.add(normalized);
      pages += 1;
      const result = await this.getJson<T[]>(normalized, options);
      if (!Array.isArray(result.data)) throw new InvalidResponseError(`Canvas pagination returned a non-array response at ${sanitizeUrl(normalized)}.`);
      if (output.length + result.data.length > this.config.maxItems) {
        throw new PaginationError(`Canvas pagination exceeded ${this.config.maxItems} items at ${sanitizeUrl(normalized)}.`);
      }
      output.push(...result.data);
      const link = nextLink(result.headers.get("link"));
      next = link ? this.canvasUrl(link) : undefined;
    }

    return output;
  }
}

export class PublicHttpClient {
  readonly limiter?: RateLimiter;
  private readonly core: BoundedHttpClient;

  constructor(
    readonly config: Config,
    options: { allowedOrigin?: string; allowAnyHttpsOrigin?: boolean; useRateLimiter?: boolean } = {},
  ) {
    this.limiter = options.useRateLimiter === false ? undefined : new RateLimiter(config, publicNamespace(options.allowedOrigin));
    this.core = new BoundedHttpClient(config, {
      allowedOrigin: options.allowedOrigin,
      allowAnyHttpsOrigin: options.allowAnyHttpsOrigin ?? !options.allowedOrigin,
      useRateLimiter: options.useRateLimiter !== false,
    }, this.limiter);
  }

  async getJson<T>(url: string, options: RequestOptions = {}): Promise<HttpResult<T>> {
    return this.core.getJson<T>(url, options);
  }

  async getText(url: string, options: RequestOptions = {}): Promise<HttpResult<string>> {
    return this.core.getText(url, options);
  }

  async downloadToFile(url: string, path: string, options: RequestOptions = {}): Promise<DownloadResult> {
    return this.core.downloadToFile(url, path, options);
  }
}

class BoundedHttpClient {
  constructor(
    private readonly config: Config,
    private readonly policy: ClientPolicy,
    private readonly limiter?: RateLimiter,
  ) {}

  async getJson<T>(url: string, options: RequestOptions): Promise<HttpResult<T>> {
    const result = await this.getText(url, options);
    try {
      return { data: JSON.parse(result.data) as T, headers: result.headers, url: result.url };
    } catch (error) {
      throw new InvalidResponseError(`GET ${sanitizeUrl(result.url)} returned invalid JSON.`, { cause: error });
    }
  }

  async getText(url: string, options: RequestOptions): Promise<HttpResult<string>> {
    return withDeadline(url, this.config.requestTimeoutMs, options.signal, async (signal) => {
      const raw = await this.requestWithRedirects(url, options.headers, signal);
      const body = await readBody(raw.response, options.maxBytes ?? this.config.maxResponseBytes, signal, false);
      const text = body.toString("utf8");
      if (!raw.response.ok) throw httpError(raw.response.status, raw.url, text, this.config.token);
      return { data: text, headers: raw.response.headers, url: raw.url.toString() };
    });
  }

  async downloadToFile(url: string, path: string, options: RequestOptions): Promise<DownloadResult> {
    return withDeadline(url, this.config.requestTimeoutMs, options.signal, async (signal) => {
      const raw = await this.requestWithRedirects(url, options.headers, signal);
      if (!raw.response.ok) {
        const body = await readBody(raw.response, Math.min(this.config.maxResponseBytes, 64 * 1024), signal, false);
        throw httpError(raw.response.status, raw.url, body.toString("utf8"), this.config.token);
      }
      const maximum = options.maxBytes ?? this.config.maxDownloadBytes;
      const length = Number(raw.response.headers.get("content-length"));
      if (Number.isFinite(length) && length > maximum) {
        await raw.response.body?.cancel();
        throw new DownloadTooLargeError(`Download from ${sanitizeUrl(raw.url)} exceeds the ${maximum}-byte limit.`);
      }
      await ensureDirectoryAsync(dirname(path));
      const handle = await open(path, "wx", 0o600);
      let bytes = 0;
      try {
        const reader = raw.response.body?.getReader();
        if (reader) {
          for (;;) {
            throwIfAborted(signal);
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > maximum) {
              await reader.cancel();
              throw new DownloadTooLargeError(`Download from ${sanitizeUrl(raw.url)} exceeds the ${maximum}-byte limit.`);
            }
            await handle.writeFile(chunk.value);
          }
        }
        await handle.sync();
      } catch (error) {
        await handle.close();
        await unlink(path).catch(() => undefined);
        throw error;
      }
      await handle.close();
      return { headers: raw.response.headers, url: raw.url.toString(), bytes };
    });
  }

  private async requestWithRedirects(
    input: string,
    extraHeaders: Record<string, string> | undefined,
    signal: AbortSignal,
  ): Promise<RawResult> {
    let current = parseAndValidateUrl(input, this.policy, this.config.allowInsecureLocalhost);
    let redirects = 0;

    for (;;) {
      const response = await this.requestWithRetries(current, extraHeaders, signal);
      if (!isRedirect(response.status)) return { response, url: current };
      const location = response.headers.get("location");
      if (!location) return { response, url: current };
      if (redirects >= this.config.maxRedirects) {
        await response.body?.cancel();
        throw new OriginPolicyError(`GET ${sanitizeUrl(current)} exceeded ${this.config.maxRedirects} redirects.`);
      }
      const next = parseAndValidateUrl(new URL(location, current).toString(), this.policy, this.config.allowInsecureLocalhost);
      if (current.protocol === "https:" && next.protocol !== "https:") {
        await response.body?.cancel();
        throw new OriginPolicyError(`Refusing an HTTPS downgrade redirect from ${sanitizeUrl(current)} to ${sanitizeUrl(next)}.`);
      }
      await response.body?.cancel();
      current = next;
      redirects += 1;
    }
  }

  private async requestWithRetries(
    url: URL,
    extraHeaders: Record<string, string> | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    let attempt = 0;
    for (;;) {
      if (this.policy.useRateLimiter) await this.limiter?.beforeRequest(signal);
      const headers = new Headers(extraHeaders);
      headers.delete("authorization");
      if (this.policy.authorization) headers.set("authorization", this.policy.authorization);
      let response: Response;
      try {
        response = await fetch(url, { method: "GET", redirect: "manual", headers, signal });
      } catch (error) {
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : error;
        if (attempt >= this.config.retryLimit) {
          throw new HttpError(0, sanitizeUrl(url), `GET ${sanitizeUrl(url)} failed due to a network error.`);
        }
        await this.limiter?.backoff(attempt, signal);
        attempt += 1;
        continue;
      }
      if (!retryableStatus(response.status) || attempt >= this.config.retryLimit) return response;
      if (response.status === 403) {
        const body = await readBody(response.clone(), Math.min(this.config.maxResponseBytes, 64 * 1024), signal, false)
          .then((value) => value.toString("utf8"))
          .catch(() => "");
        if (!/rate limit exceeded/i.test(body)) return response;
      }
      await response.body?.cancel();
      await this.limiter?.backoff(attempt, signal);
      attempt += 1;
    }
  }
}

export function validateCanvasUrl(url: URL, configuredBase: URL, allowInsecureLocalhost: boolean): void {
  validateProtocol(url, allowInsecureLocalhost);
  if (url.origin !== configuredBase.origin) {
    throw new OriginPolicyError(`Refusing to send Canvas authorization outside ${configuredBase.origin}: ${sanitizeUrl(url)}.`);
  }
  if (configuredBase.protocol === "https:" && url.protocol !== "https:") {
    throw new OriginPolicyError(`Refusing to downgrade Canvas authorization to ${sanitizeUrl(url)}.`);
  }
}

export function sanitizeUrl(input: string | URL): string {
  try {
    const url = input instanceof URL ? new URL(input) : new URL(input);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<invalid-url>";
  }
}

export function redactText(input: string, token = ""): string {
  let output = input;
  if (token) output = output.split(token).join("[redacted]");
  output = output
    .replace(/([?&\s](?:verifier|access_token|token|signature|sig|key)=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  return output.replace(/\s+/g, " ").trim().slice(0, 512);
}

export function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of splitLinkHeader(header)) {
    const match = part.match(/^\s*<([^>]+)>\s*;(.*)$/);
    if (!match?.[1] || !match[2]) continue;
    if (/(?:^|;)\s*rel\s*=\s*"?next"?(?:\s*;|$)/i.test(match[2])) return match[1];
  }
  return undefined;
}

async function readBody(
  response: Response,
  maximum: number,
  signal: AbortSignal,
  download: boolean,
): Promise<Buffer> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximum) {
    await response.body?.cancel();
    const ErrorType = download ? DownloadTooLargeError : ResponseTooLargeError;
    throw new ErrorType(`Response from ${sanitizeUrl(response.url)} exceeds the ${maximum}-byte limit.`);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  for (;;) {
    throwIfAborted(signal);
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maximum) {
      await reader.cancel();
      const ErrorType = download ? DownloadTooLargeError : ResponseTooLargeError;
      throw new ErrorType(`Response from ${sanitizeUrl(response.url)} exceeds the ${maximum}-byte limit.`);
    }
    chunks.push(Buffer.from(chunk.value));
  }
  return Buffer.concat(chunks, bytes);
}

function httpError(status: number, url: URL, body: string, token: string): HttpError {
  const safeUrl = sanitizeUrl(url);
  const safeBody = redactText(body, token);
  return new HttpError(status, safeUrl, `GET ${safeUrl} failed (${status})${safeBody ? `: ${safeBody}` : ""}`, safeBody);
}

function parseAndValidateUrl(input: string, policy: ClientPolicy, allowInsecureLocalhost: boolean): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new OriginPolicyError("HTTP requests require an absolute URL.");
  }
  if (url.username || url.password) throw new OriginPolicyError(`Refusing a URL containing embedded credentials: ${sanitizeUrl(url)}.`);
  validateProtocol(url, allowInsecureLocalhost);
  if (policy.allowedOrigin && url.origin !== policy.allowedOrigin) {
    throw new OriginPolicyError(`Refusing a cross-origin request from ${policy.allowedOrigin} to ${sanitizeUrl(url)}.`);
  }
  if (!policy.allowedOrigin && !policy.allowAnyHttpsOrigin) {
    throw new OriginPolicyError(`No public origin policy permits ${sanitizeUrl(url)}.`);
  }
  return url;
}

function validateProtocol(url: URL, allowInsecureLocalhost: boolean): void {
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && allowInsecureLocalhost && isLocalHostname(url.hostname)) return;
  throw new OriginPolicyError(`Refusing non-HTTPS URL ${sanitizeUrl(url)}.`);
}

function absoluteOrRelative(pathOrUrl: string, base: URL): URL {
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(pathOrUrl)) return new URL(pathOrUrl);
    return new URL(pathOrUrl.replace(/^\/+/, ""), base);
  } catch {
    throw new OriginPolicyError(`Invalid URL ${pathOrUrl}.`);
  }
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function retryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504 || status === 403;
}

function publicNamespace(origin: string | undefined): string {
  return `public-${Buffer.from(origin ?? "any").toString("base64url").slice(0, 32)}`;
}

function splitLinkHeader(header: string): string[] {
  const output: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < header.length; index += 1) {
    const character = header[index];
    if (character === '"') quoted = !quoted;
    if (character === "," && !quoted) {
      output.push(header.slice(start, index));
      start = index + 1;
    }
  }
  output.push(header.slice(start));
  return output;
}

async function withDeadline<T>(
  url: string,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new RequestTimeoutError(`GET ${sanitizeUrl(url)} timed out after ${timeoutMs}ms.`));
  }, timeoutMs);
  timeout.unref?.();
  const abort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener("abort", abort, { once: true });
  try {
    return await action(controller.signal);
  } catch (error) {
    if (timedOut) throw new RequestTimeoutError(`GET ${sanitizeUrl(url)} timed out after ${timeoutMs}ms.`);
    if (externalSignal?.aborted) {
      throw externalSignal.reason instanceof Error ? externalSignal.reason : new DOMException("Aborted", "AbortError");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abort);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}
