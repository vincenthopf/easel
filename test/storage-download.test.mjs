import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readHiddenInput } from "../dist/commands/init.js";
import { decodeHtml, extractCanvasFileLinks, htmlToText, safeFileName, writeOutputFile } from "../dist/lib/html.js";
import { DownloadTooLargeError } from "../dist/lib/http.js";
import { pullCanvasFile } from "../dist/lib/pull.js";
import { FileCollisionError, atomicWriteFile } from "../dist/lib/storage.js";
import { configFixture, mockServer, workspace } from "./helpers.mjs";

test("HTML conversion handles greater-than characters in attributes and hides script content", () => {
  assert.equal(
    htmlToText('<div title="a > b">Visible 2 < 3</div><script data-x=">">secret</script><p>Done</p>'),
    "Visible 2 < 3\nDone",
  );
});

test("invalid numeric entities decode safely", () => {
  assert.equal(decodeHtml("bad &#99999999; and &#xD800;"), "bad � and �");
});

test("file extraction handles greater-than characters inside quoted attributes", () => {
  const links = extractCanvasFileLinks('<a title="x > y" href="https://canvas.example/courses/1/files/2?verifier=abc">Brief</a>');
  assert.equal(links.length, 1);
  assert.equal(links[0].verifier, "abc");
  assert.equal(links[0].label, "Brief");
});

test("filename sanitization handles Windows reserved names and trailing dots or spaces", () => {
  assert.equal(safeFileName("CON.txt"), "_CON.txt");
  assert.equal(safeFileName("brief. "), "brief");
  assert.equal(safeFileName("a<b>:c?.pdf"), "a-b-c-.pdf");
});

test("text output is restrictive, atomic, and collision-safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "easel-output-"));
  try {
    const first = writeOutputFile(join(root, "notes.txt"), "one");
    const second = writeOutputFile(join(root, "notes.txt"), "two");
    assert.notEqual(first.path, second.path);
    assert.equal(await readFile(first.path, "utf8"), "one");
    assertPrivateMode((await stat(first.path)).mode);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomic configuration writes cannot leave partial files", async () => {
  const root = await mkdtemp(join(tmpdir(), "easel-atomic-"));
  try {
    const path = join(root, "config", ".env");
    await atomicWriteFile(path, "CANVAS_TOKEN=one\n");
    await atomicWriteFile(path, "CANVAS_TOKEN=two\n");
    assert.equal(await readFile(path, "utf8"), "CANVAS_TOKEN=two\n");
    assertPrivateMode((await stat(path)).mode);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("downloads stream to a private atomic destination", async () => {
  const place = await workspace();
  const root = await mkdtemp(join(tmpdir(), "easel-download-"));
  const server = await mockServer((_request, response) => {
    response.setHeader("content-type", "application/pdf");
    response.write("first");
    setTimeout(() => response.end("second"), 10);
  });
  try {
    const canvas = {
      config: configFixture("http://localhost:3000", { cacheDir: place.cache }),
      fileMeta: async () => ({ id: 9, display_name: "brief.pdf", size: 11, url: `${server.baseUrl}/signed?verifier=secret` }),
    };
    const result = await pullCanvasFile(canvas, { courseId: 1, fileId: 9, original: "1/9" }, { directory: root });
    assert.equal(await readFile(result.path, "utf8"), "firstsecond");
    assertPrivateMode((await stat(result.path)).mode);
    assert.equal(result.bytes, 11);
  } finally {
    await Promise.all([server.close(), place.cleanup(), rm(root, { recursive: true, force: true })]);
  }
});

test("explicit download output refuses overwrite without --overwrite", async () => {
  const place = await workspace();
  const root = await mkdtemp(join(tmpdir(), "easel-download-collision-"));
  const output = join(root, "brief.pdf");
  await writeFile(output, "existing");
  try {
    const canvas = {
      config: configFixture("http://localhost:3000", { cacheDir: place.cache }),
      fileMeta: async () => ({ id: 9, display_name: "brief.pdf", size: 1, url: "http://localhost:9/signed" }),
    };
    await assert.rejects(pullCanvasFile(canvas, { courseId: 1, fileId: 9, original: "1/9" }, { output }), FileCollisionError);
    assert.equal(await readFile(output, "utf8"), "existing");
  } finally {
    await Promise.all([place.cleanup(), rm(root, { recursive: true, force: true })]);
  }
});

test("download size limits abort and remove temporary files", async () => {
  const place = await workspace();
  const root = await mkdtemp(join(tmpdir(), "easel-download-limit-"));
  const server = await mockServer((_request, response) => response.end("0123456789"));
  try {
    const canvas = {
      config: configFixture("http://localhost:3000", { cacheDir: place.cache, maxDownloadBytes: 5 }),
      fileMeta: async () => ({ id: 9, display_name: "brief.pdf", url: `${server.baseUrl}/signed` }),
    };
    await assert.rejects(pullCanvasFile(canvas, { courseId: 1, fileId: 9, original: "1/9" }, { directory: root }), DownloadTooLargeError);
    assert.equal(existsSync(join(root, "brief.pdf")), false);
  } finally {
    await Promise.all([server.close(), place.cleanup(), rm(root, { recursive: true, force: true })]);
  }
});

test("hidden token input does not echo secret bytes", async () => {
  class FakeInput extends EventEmitter {
    isTTY = true;
    isRaw = false;
    setRawMode(value) { this.isRaw = value; }
    resume() {}
    pause() {}
  }
  const input = new FakeInput();
  let output = "";
  const promise = readHiddenInput(input, { write(value) { output += value; } }, "Token: ");
  input.emit("data", Buffer.from("super-secret\r"));
  assert.equal(await promise, "super-secret");
  assert.equal(output, "Token: \n");
  assert.doesNotMatch(output, /super-secret/);
});

function assertPrivateMode(mode) {
  if (process.platform !== "win32") assert.equal(mode & 0o077, 0);
}
