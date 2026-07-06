import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface TextView {
  title?: string;
  text: string;
  bytes?: number;
}

export interface FileLink {
  courseId: number;
  fileId: number;
  verifier?: string;
  url: string;
  label?: string;
}

const blockTags = /<\/?(?:address|article|aside|blockquote|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)[^>]*>/gi;

export function htmlToText(html = ""): string {
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(blockTags, "\n")
    .replace(/<[^>]+>/g, " ");

  return decodeHtml(withoutScripts)
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function decodeHtml(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)));
}

export function titleFromHtml(html: string): string | undefined {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const title = h1 ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return title ? singleLine(htmlToText(title)) : undefined;
}

export function compactText(text: string, maxChars = 1600): string {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
  const body = cut.slice(0, lastBreak > 500 ? lastBreak + 1 : maxChars).trim();
  return `${body}\n…`;
}

export function objectiveText(text: string, objective: string, maxChars = 2000): string {
  const terms = objective
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((term) => term.length > 2);
  if (terms.length === 0) return compactText(text, maxChars);

  const paragraphs = text
    .split(/\n{1,2}/)
    .map((body, index) => ({ body: body.trim(), index }))
    .filter((p) => p.body);

  const scored = paragraphs
    .map((p) => {
      const lower = p.body.toLowerCase();
      const score = terms.reduce((sum, term) => sum + occurrences(lower, term), 0);
      return { ...p, score };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  if (scored.length === 0) return compactText(text, maxChars);

  const picked = new Map<number, string>();
  for (const item of scored.slice(0, 6)) {
    const before = paragraphs[item.index - 1];
    const after = paragraphs[item.index + 1];
    if (before && before.body.length < 500) picked.set(before.index, before.body);
    picked.set(item.index, item.body);
    if (after && after.body.length < 500) picked.set(after.index, after.body);
  }

  return compactText(
    [...picked.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, body]) => body)
      .join("\n"),
    maxChars,
  );
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  for (;;) {
    const found = haystack.indexOf(needle, pos);
    if (found === -1) return count;
    count++;
    pos = found + needle.length;
  }
}

export function renderContent(view: TextView, options: { full?: boolean; objective?: string; maxChars?: number }): string {
  const source = view.text.trim();
  if (options.objective) return objectiveText(source, options.objective, options.maxChars ?? 2200);
  if (options.full) return source;
  return compactText(source, options.maxChars ?? 1600);
}

export function writeOutputFile(path: string, content: string): { path: string; bytes: number } {
  const fullPath = resolve(path);
  mkdirSync(dirname(fullPath), { recursive: true });
  const bytes = Buffer.byteLength(content);
  writeFileSync(fullPath, content);
  return { path: fullPath, bytes };
}

export function singleLine(value: unknown, fallback = ""): string {
  return String(value ?? fallback)
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(value: string, length = 120): string {
  const clean = singleLine(value);
  return clean.length <= length ? clean : `${clean.slice(0, Math.max(0, length - 1)).trim()}…`;
}

export function extractCanvasFileLinks(html: string, baseUrl = ""): FileLink[] {
  const links: FileLink[] = [];
  const seen = new Set<string>();
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorRe.exec(html))) {
    const attrs = match[1] ?? "";
    const href = attrs.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    addFileLink(links, seen, absolutize(decodeHtml(href), baseUrl), htmlToText(match[2] ?? ""));
  }

  const plainRe = /https?:\/\/[^\s"'<>]+\/courses\/\d+\/files\/\d+(?:\?[^\s"'<>]+)?/gi;
  while ((match = plainRe.exec(html))) {
    addFileLink(links, seen, decodeHtml(match[0]), undefined);
  }

  return links;
}

function addFileLink(out: FileLink[], seen: Set<string>, url: string, label?: string): void {
  const match = url.match(/\/courses\/(\d+)\/files\/(\d+)(?:\?([^#]+))?/i);
  if (!match) return;
  const courseId = Number(match[1]);
  const fileId = Number(match[2]);
  const params = new URLSearchParams(match[3] ?? "");
  const verifier = params.get("verifier") ?? undefined;
  const key = `${courseId}:${fileId}:${verifier ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ courseId, fileId, verifier, url, label: label ? singleLine(label) : undefined });
}

function absolutize(url: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (!baseUrl) return url;
  try {
    return new URL(url, `${baseUrl.replace(/\/+$/, "")}/`).toString();
  } catch {
    return url;
  }
}

export function safeFileName(name: string): string {
  return singleLine(name || "download")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || "download";
}
