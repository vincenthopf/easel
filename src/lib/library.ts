import type { Config } from "./config.js";
import { htmlToText, objectiveText, titleFromHtml, truncate } from "./html.js";
import { HttpError, ReadOnlyHttpClient } from "./http.js";

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

interface SpringshareDoc {
  guide?: string;
  page?: string;
  gd?: string;
  h?: string;
  slug?: string;
  pslug?: string;
  p?: number;
  g?: number;
  updated?: string;
}

interface SpringshareGroup {
  doclist?: { docs?: SpringshareDoc[] };
}

interface SpringshareSearch {
  grouped?: { g?: { groups?: SpringshareGroup[] } };
}

function absolute(url: string, base: string): string {
  try {
    return new URL(url, `${base.replace(/\/+$/, "")}/`).toString();
  } catch {
    return url;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function encodeQ(q: string): string {
  return encodeURIComponent(q.trim());
}

export class LibraryClient {
  readonly http: ReadOnlyHttpClient;

  constructor(private readonly config: Config) {
    this.http = new ReadOnlyHttpClient(config);
  }

  async search(query: string): Promise<LibraryResult[]> {
    const api = await this.springshareSearch(query);
    if (api.length > 0) return api;

    const candidates = [
      `${this.config.libraryBaseUrl}/srch.php?q=${encodeQ(query)}`,
      `${this.config.libraryBaseUrl}/srch.php?search=${encodeQ(query)}`,
      `${this.config.libraryBaseUrl}/search/?q=${encodeQ(query)}`,
    ];

    for (const url of candidates) {
      try {
        const html = (await this.http.getText(url, { auth: false })).data;
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
    const result = await this.http.getText(fullUrl, { auth: false });
    const title = titleFromHtml(result.data);
    const text = htmlToText(result.data);
    return {
      title,
      url: result.url,
      text,
      bytes: Buffer.byteLength(text),
    };
  }

  private async springshareSearch(query: string): Promise<LibraryResult[]> {
    const params = new URLSearchParams();
    params.append("search_source_id", "821");
    params.append("rows", "20");
    params.append("facet.limit", "20");
    params.append("group.limit", "4");
    params.append("fq", "s:267");
    params.append("start", "0");
    params.append("q", query.trim());
    params.append("sort", "score desc");

    const url = `https://lgapi-au.libapps.com/1.1/cloudsearch/lg2-local?${params.toString()}`;
    const text = (await this.http.getText(url, { auth: false })).data;
    const data = parseJsonp(text) as SpringshareSearch;
    const out: LibraryResult[] = [];
    const seen = new Set<string>();

    for (const group of data.grouped?.g?.groups ?? []) {
      const docs = group.doclist?.docs ?? [];
      for (const doc of docs) {
        const result = docToResult(doc, hostOf(this.config.libraryBaseUrl));
        if (!result || seen.has(result.url)) continue;
        seen.add(result.url);
        out.push(result);
      }
    }

    return out.slice(0, 10);
  }
}

function parseJsonp(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf("(");
  const end = trimmed.lastIndexOf(")");
  const json = start >= 0 && end > start ? trimmed.slice(start + 1, end) : trimmed;
  return JSON.parse(json);
}

function docToResult(doc: SpringshareDoc, fallbackHost: string): LibraryResult | undefined {
  const host = doc.h || fallbackHost;
  let path = doc.pslug || doc.slug || "";
  if (!path && doc.g && doc.p) path = `c.php?g=${doc.g}&p=${doc.p}`;
  if (!path || !host) return undefined;
  const url = `https://${host}/${path.replace(/^\/+/, "")}`;
  const title = [doc.guide, doc.page].filter(Boolean).join(" — ") || doc.page || doc.guide;
  return {
    title: truncate(title ?? url, 140),
    url,
    excerpt: doc.gd ? truncate(htmlToText(doc.gd), 180) : undefined,
  };
}

function parseAnchorResults(html: string, base: string, query: string): LibraryResult[] {
  const out: LibraryResult[] = [];
  const seen = new Set<string>();
  const libHost = hostOf(base);
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorRe.exec(html))) {
    const attrs = match[1] ?? "";
    const href = attrs.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    const text = htmlToText(match[2] ?? "");
    if (!text || text.length < 3) continue;
    const url = absolute(href, base);
    if (!/^https?:\/\//i.test(url)) continue;
    if (libHost && !url.includes(libHost) && href.startsWith("#")) continue;
    const lower = `${text} ${url}`.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
    if (score === 0 && !/libguides|library|referenc|guide|database|article|ebook/i.test(lower)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ title: truncate(text, 120), url });
  }

  if (out.length > 0) return out;

  const text = htmlToText(html);
  const focused = objectiveText(text, query, 1200);
  return focused ? [{ title: `Search results for ${query}`, url: `${base}/srch.php?q=${encodeURIComponent(query)}`, excerpt: focused }] : [];
}
