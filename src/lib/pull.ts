import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { CanvasClient } from "./canvas.js";
import type { CanvasFileMeta } from "./canvas-types.js";
import { extractCanvasFileLinks, safeFileName } from "./html.js";

export interface PullTarget {
  courseId: number;
  fileId: number;
  verifier?: string;
  original: string;
}

export interface PullResult {
  courseId: number;
  fileId: number;
  displayName: string;
  contentType?: string;
  path: string;
  bytes: number;
  sourceUrl: string;
  signedUrl: string;
}

export function parsePullTarget(input: string, baseUrl: string): PullTarget | undefined {
  const fromHtml = extractCanvasFileLinks(input, baseUrl)[0];
  if (fromHtml) {
    return {
      courseId: fromHtml.courseId,
      fileId: fromHtml.fileId,
      verifier: fromHtml.verifier,
      original: input,
    };
  }

  const compact = input.match(/^(\d+)\/(\d+)$/);
  if (compact) {
    return { courseId: Number(compact[1]), fileId: Number(compact[2]), original: input };
  }

  const canvasMatch = input.match(/\/courses\/(\d+)\/files\/(\d+)(?:\?([^#]+))?/i);
  if (canvasMatch) {
    const params = new URLSearchParams(canvasMatch[3] ?? "");
    return {
      courseId: Number(canvasMatch[1]),
      fileId: Number(canvasMatch[2]),
      verifier: params.get("verifier") ?? undefined,
      original: input,
    };
  }

  return undefined;
}

export async function pullCanvasFile(
  canvas: CanvasClient,
  target: PullTarget,
  options: { output?: string; directory?: string } = {},
): Promise<PullResult> {
  const meta = await canvas.fileMeta(target.courseId, target.fileId);
  const download = await canvas.http.getBinary(meta.url, { auth: false });
  const path = resolveOutput(meta, options);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, download.bytes);

  return {
    courseId: target.courseId,
    fileId: target.fileId,
    displayName: meta.display_name ?? meta.filename ?? `file-${target.fileId}`,
    contentType: meta["content-type"] ?? meta.content_type ?? download.headers.get("content-type") ?? undefined,
    path,
    bytes: download.bytes.length,
    sourceUrl: target.original,
    signedUrl: meta.url,
  };
}

function resolveOutput(meta: CanvasFileMeta, options: { output?: string; directory?: string }): string {
  if (options.output) return resolve(options.output);
  const dir = resolve(options.directory ?? ".");
  const name = safeFileName(meta.display_name ?? meta.filename ?? `file-${meta.id}`);
  return uniquePath(join(dir, name));
}

function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  const dot = path.lastIndexOf(".");
  const base = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : "";
  for (let i = 2; i < 1000; i++) {
    const next = `${base}-${i}${ext}`;
    if (!existsSync(next)) return next;
  }
  return `${base}-${Date.now()}${ext}`;
}
