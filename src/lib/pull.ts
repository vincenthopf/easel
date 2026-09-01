import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { CanvasClient } from "./canvas.js";
import type { CanvasFileMeta } from "./canvas-types.js";
import { extractCanvasFileLinks, safeFileName } from "./html.js";
import { DownloadTooLargeError, PublicHttpClient } from "./http.js";
import {
  commitTemporaryFile,
  ensureDirectoryAsync,
  FileCollisionError,
  temporaryPath,
  uniquePath,
} from "./storage.js";

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
}

export function parsePullTarget(input: string, baseUrl: string): PullTarget | undefined {
  const embedded = extractCanvasFileLinks(input, baseUrl)[0];
  if (embedded) {
    return {
      courseId: embedded.courseId,
      fileId: embedded.fileId,
      verifier: embedded.verifier,
      original: input,
    };
  }
  const compact = input.match(/^(\d+)\/(\d+)$/);
  if (compact) return { courseId: Number(compact[1]), fileId: Number(compact[2]), original: input };
  try {
    const url = new URL(input, `${baseUrl.replace(/\/+$/, "")}/`);
    const match = url.pathname.match(/\/courses\/(\d+)\/files\/(\d+)/i);
    if (!match) return undefined;
    return {
      courseId: Number(match[1]),
      fileId: Number(match[2]),
      verifier: url.searchParams.get("verifier") ?? undefined,
      original: input,
    };
  } catch {
    return undefined;
  }
}

export async function pullCanvasFile(
  canvas: CanvasClient,
  target: PullTarget,
  options: { output?: string; directory?: string; overwrite?: boolean; signal?: AbortSignal } = {},
): Promise<PullResult> {
  if (options.output && existsSync(resolve(options.output)) && !options.overwrite) {
    throw new FileCollisionError(`Refusing to overwrite existing file ${resolve(options.output)}. Use --overwrite to replace it.`);
  }
  const meta = await canvas.fileMeta(target.courseId, target.fileId, target.verifier);
  if (Number.isFinite(meta.size) && Number(meta.size) > canvas.config.maxDownloadBytes) {
    throw new DownloadTooLargeError(`Canvas file ${target.courseId}/${target.fileId} exceeds the configured download limit.`);
  }
  const finalPath = resolveOutput(meta, options);
  if (options.output && existsSync(finalPath) && !options.overwrite) {
    throw new FileCollisionError(`Refusing to overwrite existing file ${finalPath}. Use --overwrite to replace it.`);
  }
  await ensureDirectoryAsync(dirname(finalPath));
  const temporary = temporaryPath(finalPath);
  const signedUrl = withVerifier(meta.url, target.verifier);
  const publicHttp = new PublicHttpClient(canvas.config, { allowAnyHttpsOrigin: true, useRateLimiter: true });
  const download = await publicHttp.downloadToFile(signedUrl, temporary, {
    signal: options.signal,
    maxBytes: canvas.config.maxDownloadBytes,
  });
  await commitTemporaryFile(temporary, finalPath, options.overwrite === true);
  return {
    courseId: target.courseId,
    fileId: target.fileId,
    displayName: meta.display_name ?? meta.filename ?? `file-${target.fileId}`,
    contentType: meta["content-type"] ?? meta.content_type ?? download.headers.get("content-type") ?? undefined,
    path: finalPath,
    bytes: download.bytes,
  };
}

function resolveOutput(
  meta: CanvasFileMeta,
  options: { output?: string; directory?: string; overwrite?: boolean },
): string {
  if (options.output) return resolve(options.output);
  const directory = resolve(options.directory ?? ".");
  const name = safeFileName(meta.display_name ?? meta.filename ?? `file-${meta.id}`);
  return uniquePath(join(directory, name));
}

function withVerifier(input: string, verifier?: string): string {
  const url = new URL(input);
  if (verifier && !url.searchParams.has("verifier")) url.searchParams.set("verifier", verifier);
  return url.toString();
}
