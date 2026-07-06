import { Buffer } from "node:buffer";

import type { Config } from "./config.js";
import { RateLimiter } from "./rate-limiter.js";

export class HttpError extends Error {
  override name = "HttpError";

  constructor(
    readonly status: number,
    readonly url: string,
    message: string,
    readonly body = "",
  ) {
    super(message);
  }
}

export interface HttpResult<T> {
  data: T;
  headers: Headers;
  url: string;
}

export interface BinaryResult {
  bytes: Buffer;
  headers: Headers;
  url: string;
}

interface RequestOptions {
  auth?: boolean;
  headers?: Record<string, string>;
}

function isAbsoluteUrl(pathOrUrl: string): boolean {
  return /^https?:\/\//i.test(pathOrUrl);
}

function joinUrl(base: string, pathOrUrl: string): string {
  if (isAbsoluteUrl(pathOrUrl)) return pathOrUrl;
  const baseClean = base.replace(/\/+$/, "");
  const pathClean = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${baseClean}${pathClean}`;
}

function safeMessage(status: number, url: string, body: string): string {
  const text = body.replace(/\s+/g, " ").trim().slice(0, 240);
  return `GET ${url} failed (${status})${text ? `: ${text}` : ""}`;
}

function rateLimited(status: number, body: string): boolean {
  return status === 429 || (status === 403 && /rate limit exceeded/i.test(body));
}

export class ReadOnlyHttpClient {
  readonly limiter: RateLimiter;

  constructor(private readonly config: Config) {
    this.limiter = new RateLimiter(config);
  }

  canvasUrl(pathOrUrl: string): string {
    if (isAbsoluteUrl(pathOrUrl)) return pathOrUrl;
    const api = `${this.config.baseUrl}/api/v1`;
    return joinUrl(api, pathOrUrl);
  }

  siteUrl(pathOrUrl: string): string {
    return joinUrl(this.config.baseUrl, pathOrUrl);
  }

  libraryUrl(pathOrUrl: string): string {
    return joinUrl(this.config.libraryBaseUrl, pathOrUrl);
  }

  async getJson<T>(url: string, options: RequestOptions = {}): Promise<HttpResult<T>> {
    const response = await this.getResponse(url, options);
    const text = await response.text();
    if (!response.ok) throw new HttpError(response.status, response.url, safeMessage(response.status, response.url, text), text);
    return { data: JSON.parse(text) as T, headers: response.headers, url: response.url };
  }

  async getText(url: string, options: RequestOptions = {}): Promise<HttpResult<string>> {
    const response = await this.getResponse(url, options);
    const text = await response.text();
    if (!response.ok) throw new HttpError(response.status, response.url, safeMessage(response.status, response.url, text), text);
    return { data: text, headers: response.headers, url: response.url };
  }

  async getBinary(url: string, options: RequestOptions = {}): Promise<BinaryResult> {
    const response = await this.getResponse(url, options);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      const body = bytes.toString("utf8").slice(0, 1000);
      throw new HttpError(response.status, response.url, safeMessage(response.status, response.url, body), body);
    }
    return { bytes, headers: response.headers, url: response.url };
  }

  async getPaginated<T>(url: string, options: RequestOptions = {}): Promise<T[]> {
    let next: string | undefined = url;
    const out: T[] = [];

    while (next) {
      const result = await this.getJson<T[]>(next, options);
      out.push(...result.data);
      next = nextLink(result.headers.get("link"));
    }

    return out;
  }

  private async getResponse(url: string, options: RequestOptions): Promise<Response> {
    let attempt = 0;

    for (;;) {
      await this.limiter.beforeRequest();
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      if (options.auth !== false) headers.Authorization = `Bearer ${this.config.token}`;

      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers,
      });

      if (response.status !== 429 && response.status !== 403) return response;
      const body = await cloneBody(response);
      if (!rateLimited(response.status, body)) return response;
      if (attempt >= 4) return response;
      await this.limiter.backoff(attempt++);
    }
  }
}

async function cloneBody(response: Response): Promise<string> {
  try {
    return await response.clone().text();
  } catch {
    return "";
  }
}

function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/i);
    if (match?.[1]) return match[1];
  }
  return undefined;
}
