import { resolve } from "node:path";

import { writeUniqueTextFileSync } from "./storage.js";

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

const blockTagNames = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre",
  "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);
const hiddenTagNames = new Set(["script", "style", "noscript"]);

export function htmlToText(html = ""): string {
  return decodeHtml(stripMarkup(html))
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
    .replace(/&#(\d+);/g, (_, value: string) => codePoint(value, 10))
    .replace(/&#x([0-9a-f]+);/gi, (_, value: string) => codePoint(value, 16));
}

export function titleFromHtml(html: string): string | undefined {
  const heading = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const title = heading ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
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
  const terms = objective.toLowerCase().split(/[^a-z0-9]+/i).filter((term) => term.length > 2);
  if (terms.length === 0) return compactText(text, maxChars);
  const paragraphs = text
    .split(/\n{1,2}/)
    .map((body, index) => ({ body: body.trim(), index }))
    .filter((paragraph) => paragraph.body);
  const scored = paragraphs
    .map((paragraph) => ({
      ...paragraph,
      score: terms.reduce((sum, term) => sum + occurrences(paragraph.body.toLowerCase(), term), 0),
    }))
    .filter((paragraph) => paragraph.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  if (scored.length === 0) return compactText(text, maxChars);
  const picked = new Map<number, string>();
  for (const item of scored.slice(0, 6)) {
    const before = paragraphs[item.index - 1];
    const after = paragraphs[item.index + 1];
    if (before && before.body.length < 500) picked.set(before.index, before.body);
    picked.set(item.index, item.body);
    if (after && after.body.length < 500) picked.set(after.index, after.body);
  }
  return compactText([...picked.entries()].sort((left, right) => left[0] - right[0]).map((entry) => entry[1]).join("\n"), maxChars);
}

export function renderContent(view: TextView, options: { full?: boolean; objective?: string; maxChars?: number }): string {
  const source = view.text.trim();
  if (options.objective) return objectiveText(source, options.objective, options.maxChars ?? 2200);
  if (options.full) return source;
  return compactText(source, options.maxChars ?? 1600);
}

export function writeOutputFile(path: string, content: string): { path: string; bytes: number } {
  return writeUniqueTextFileSync(resolve(path), content);
}

export function singleLine(value: unknown, fallback = ""): string {
  return String(value ?? fallback).replace(/\s+/g, " ").trim();
}

export function truncate(value: string, length = 120): string {
  const clean = singleLine(value);
  return clean.length <= length ? clean : `${clean.slice(0, Math.max(0, length - 1)).trim()}…`;
}

export function extractCanvasFileLinks(html: string, baseUrl = ""): FileLink[] {
  const links: FileLink[] = [];
  const seen = new Set<string>();
  for (const anchor of anchors(html)) {
    const href = attribute(anchor.attributes, "href");
    if (!href) continue;
    addFileLink(links, seen, absolutize(decodeHtml(href), baseUrl), htmlToText(anchor.body));
  }
  const plain = /https?:\/\/[^\s"'<>]+\/courses\/\d+\/files\/\d+(?:\?[^\s"'<>]+)?/gi;
  let match: RegExpExecArray | null;
  while ((match = plain.exec(html))) addFileLink(links, seen, decodeHtml(match[0]), undefined);
  return links;
}

export function safeFileName(name: string): string {
  let output = singleLine(name || "download")
    .replace(/[\u0000-\u001f\u007f]/g, "-")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 160)
    .replace(/[. ]+$/g, "");
  if (!output) output = "download";
  const stem = output.split(".")[0]?.toUpperCase() ?? "";
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) output = `_${output}`;
  return output;
}


function stripMarkup(html: string): string {
  const output: string[] = [];
  const lower = html.toLowerCase();
  let position = 0;
  while (position < html.length) {
    if (html.startsWith("<!--", position)) {
      const end = html.indexOf("-->", position + 4);
      position = end < 0 ? html.length : end + 3;
      output.push(" ");
      continue;
    }
    if (html[position] !== "<" || !/[A-Za-z!/?]/.test(html[position + 1] ?? "")) {
      output.push(html[position] ?? "");
      position += 1;
      continue;
    }
    const end = tagEnd(html, position + 1);
    if (end < 0) {
      output.push("<");
      position += 1;
      continue;
    }
    const token = html.slice(position + 1, end).trim();
    const match = token.match(/^\/?\s*([A-Za-z][A-Za-z0-9:-]*)/);
    if (!match?.[1]) {
      position = end + 1;
      output.push(" ");
      continue;
    }
    const name = match[1].toLowerCase();
    const closing = token.startsWith("/");
    if (!closing && hiddenTagNames.has(name)) {
      const closeStart = lower.indexOf(`</${name}`, end + 1);
      if (closeStart < 0) {
        position = html.length;
        output.push(" ");
        continue;
      }
      const closeEnd = tagEnd(html, closeStart + name.length + 2);
      position = closeEnd < 0 ? html.length : closeEnd + 1;
      output.push(" ");
      continue;
    }
    output.push(blockTagNames.has(name) ? "\n" : " ");
    position = end + 1;
  }
  return output.join("");
}

function codePoint(value: string, radix: number): string {
  const number = Number.parseInt(value, radix);
  if (!Number.isInteger(number) || number < 0 || number > 0x10ffff || (number >= 0xd800 && number <= 0xdfff)) return "�";
  return String.fromCodePoint(number);
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let position = 0;
  for (;;) {
    const found = haystack.indexOf(needle, position);
    if (found === -1) return count;
    count += 1;
    position = found + needle.length;
  }
}

function addFileLink(output: FileLink[], seen: Set<string>, url: string, label?: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  const match = parsed.pathname.match(/\/courses\/(\d+)\/files\/(\d+)/i);
  if (!match) return;
  const courseId = Number(match[1]);
  const fileId = Number(match[2]);
  const verifier = parsed.searchParams.get("verifier") ?? undefined;
  const key = `${courseId}:${fileId}:${verifier ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  output.push({ courseId, fileId, verifier, url: parsed.toString(), label: label ? singleLine(label) : undefined });
}

function absolutize(url: string, baseUrl: string): string {
  if (!baseUrl && !/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  try {
    return new URL(url, `${baseUrl.replace(/\/+$/, "")}/`).toString();
  } catch {
    return url;
  }
}

function anchors(html: string): Array<{ attributes: string; body: string }> {
  const output: Array<{ attributes: string; body: string }> = [];
  const lower = html.toLowerCase();
  let position = 0;
  while (position < html.length) {
    const start = lower.indexOf("<a", position);
    if (start < 0) break;
    const next = lower[start + 2];
    if (next && !/[\s>]/.test(next)) {
      position = start + 2;
      continue;
    }
    const openEnd = tagEnd(html, start + 2);
    if (openEnd < 0) break;
    const close = lower.indexOf("</a", openEnd + 1);
    if (close < 0) break;
    const closeEnd = tagEnd(html, close + 3);
    if (closeEnd < 0) break;
    output.push({ attributes: html.slice(start + 2, openEnd), body: html.slice(openEnd + 1, close) });
    position = closeEnd + 1;
  }
  return output;
}

function tagEnd(html: string, start: number): number {
  let quote = "";
  for (let index = start; index < html.length; index += 1) {
    const character = html[index] ?? "";
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return -1;
}

function attribute(attributes: string, name: string): string | undefined {
  const expression = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = attributes.match(expression);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}
