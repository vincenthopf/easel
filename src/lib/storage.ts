import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod, link, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { UserError } from "./errors.js";

export class FileCollisionError extends UserError {}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

export async function ensurePrivateDirectoryAsync(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
}

export function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}

export async function ensureDirectoryAsync(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export function atomicWriteFileSync(path: string, content: string | Buffer, mode = 0o600): void {
  ensurePrivateDirectory(dirname(path));
  const temporary = temporaryPath(path);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", mode);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    replaceFileSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    tryUnlinkSync(temporary);
    throw error;
  }
}

export async function atomicWriteFile(path: string, content: string | Uint8Array, mode = 0o600): Promise<void> {
  await ensurePrivateDirectoryAsync(dirname(path));
  const temporary = temporaryPath(path);
  try {
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await replaceFile(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export function readJsonFile<T>(path: string): T | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function writeJsonFileSync(path: string, value: unknown): void {
  atomicWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function temporaryPath(finalPath: string): string {
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
  return join(dirname(finalPath), `.${basename(finalPath)}.${suffix}.tmp`);
}

export function commitTemporaryFileSync(temporary: string, finalPath: string, overwrite: boolean): void {
  ensureDirectory(dirname(finalPath));
  if (overwrite) {
    try {
      replaceFileSync(temporary, finalPath);
    } catch (error) {
      tryUnlinkSync(temporary);
      throw error;
    }
    return;
  }
  try {
    linkSync(temporary, finalPath);
    unlinkSync(temporary);
  } catch (error) {
    tryUnlinkSync(temporary);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new FileCollisionError(`Refusing to overwrite existing file ${finalPath}. Use --overwrite to replace it.`);
    }
    throw error;
  }
}

export async function commitTemporaryFile(temporary: string, finalPath: string, overwrite: boolean): Promise<void> {
  await ensureDirectoryAsync(dirname(finalPath));
  if (overwrite) {
    try {
      await replaceFile(temporary, finalPath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return;
  }
  try {
    await link(temporary, finalPath);
    await unlink(temporary);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new FileCollisionError(`Refusing to overwrite existing file ${finalPath}. Use --overwrite to replace it.`);
    }
    throw error;
  }
}

export function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  const name = basename(path);
  const index = name.lastIndexOf(".");
  const stem = index > 0 ? name.slice(0, index) : name;
  const extension = index > 0 ? name.slice(index) : "";
  const directory = dirname(path);
  for (let number = 2; number < 10_000; number += 1) {
    const candidate = join(directory, `${stem}-${number}${extension}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new FileCollisionError(`Unable to choose a free output name near ${path}.`);
}

export function writeUniqueTextFileSync(path: string, content: string): { path: string; bytes: number } {
  const finalPath = uniquePath(path);
  const temporary = temporaryPath(finalPath);
  ensureDirectory(dirname(finalPath));
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    commitTemporaryFileSync(temporary, finalPath, false);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    tryUnlinkSync(temporary);
    throw error;
  }
  return { path: finalPath, bytes: Buffer.byteLength(content) };
}

function replaceFileSync(source: string, destination: string): void {
  renameSync(source, destination);
}

async function replaceFile(source: string, destination: string): Promise<void> {
  await rename(source, destination);
}

function tryUnlinkSync(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    return;
  }
}
