import type { Config } from "./config.js";
import { ConfigError } from "./config.js";
import { htmlToText, objectiveText, titleFromHtml, truncate } from "./html.js";
import { HttpError, PublicHttpClient } from "./http.js";

export interface LibraryResult {
  title: string;
  url: string;
  excerpt?: string;
}

export interface LibraryPage {
  title?: string;
  url: string;
  text: string;
  bytes: number;
}

export class LibraryClient {
  private readonly searchHttp: PublicHttpClient;
  private readonly publicHttp: PublicHttpClient;

  constructor(private readonly config: Config) {
    const origin = config.libraryBaseUrl ? new URL(config.libraryBaseUrl).origin : undefined;
    this.searchHttp = new PublicHttpClient(config, { allowedOrigin: origin, useRateLimiter: true });
    this.publicHttp = new PublicHttpClient(config, { allowAnyHttpsOrigin: true, useRateLimiter: true });
  }

  async search(query: string): Promise<LibraryResult[]> {
    if (!this.config.libraryBaseUrl) {
      throw new ConfigError("Library search requires LIBRARY_BASE_URL. Run `easel init` or set it in the user config.");
    }
    const candidates = [
      new URL(`srch.php?q=${encodeURIComponent(query.trim())}`, `${this.config.libraryBaseUrl}/`).toString(),
      new URL(`srch.php?search=${encodeURIComponent(query.trim())}`, `${this.config.libraryBaseUrl}/`).toString(),
      new URL(`search/?q=${encodeURIComponent(query.trim())}`, `${this.config.libraryBaseUrl}/`).toString(),
    ];
    for (const url of candidates) {
      try {
        const html = (await this.searchHttp.getText(url)).data;
        const results = parseAnchorResults(html, this.config.libraryBaseUrl, query);
        if (results.length > 0) return results.slice(0, 10);
      } catch (error) {
        if (error instanceof HttpError && [404, 410].includes(error.status)) continue;
        throw error;
      }
    }
    return [];
  }

  async fetch(url: string): Promise<LibraryPage> {
    const fullUrl = absolute(url, this.config.libraryBaseUrl);
    const result = await this.publicHttp.getText(fullUrl);
    const title = titleFromHtml(result.data);
    const text = htmlToText(result.data);
    return { title, url: result.url, text, bytes: Buffer.byteLength(text) };
  }
}

function absolute(url: string, base: string): string {
  try {
    return new URL(url, base ? `${base.replace(/\/+$/, "")}/` : undefined).toString();
  } catch {
    throw new ConfigError("Library fetch requires an absolute HTTPS URL or a URL relative to LIBRARY_BASE_URL.");
  }
}

function parseAnchorResults(html: string, base: string, query: string): LibraryResult[] {
  const output: LibraryResult[] = [];
  const seen = new Set<string>();
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const expression = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(html))) {
    const href = match[1]?.match(/href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
    const rawUrl = href?.[1] ?? href?.[2] ?? href?.[3];
    if (!rawUrl) continue;
    const title = htmlToText(match[2] ?? "");
    if (title.length < 3) continue;
    let url: string;
    try {
      url = new URL(rawUrl, `${base.replace(/\/+$/, "")}/`).toString();
    } catch {
      continue;
    }
    const searchable = `${title} ${url}`.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (searchable.includes(term) ? 1 : 0), 0);
    if (score === 0 && !/libguides|library|reference|guide|database|article|ebook/i.test(searchable)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    output.push({ title: truncate(title, 120), url });
  }
  if (output.length > 0) return output;
  const text = htmlToText(html);
  const excerpt = objectiveText(text, query, 1200);
  return excerpt
    ? [{ title: `Search results for ${query}`, url: new URL(`srch.php?q=${encodeURIComponent(query)}`, `${base}/`).toString(), excerpt }]
    : [];
}
