import { access, readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const roots = ["src", "scripts", "test", ".github"];
const files = [".env.example", ".release-please-manifest.json", "PROJECT.txt", "README.md", "package.json", "release-please-config.json", "setup.sh", "tsconfig.json"];
const extensions = new Set([".ts", ".mjs", ".json", ".yml", ".yaml", ".md", ".sh"]);
const failures = [];

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (extensions.has(extname(entry.name))) await check(path);
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function check(path) {
  const text = await readFile(path, "utf8");
  if (!text.endsWith("\n")) failures.push(`${path}: missing final newline`);
  if (/^<{7} |^={7}$|^>{7} /m.test(text)) failures.push(`${path}: merge marker`);
  for (const [index, line] of text.split("\n").entries()) {
    if (/[ \t]+$/.test(line)) failures.push(`${path}:${index + 1}: trailing whitespace`);
    if ((path.endsWith(".ts") || path.endsWith(".mjs")) && line.includes("\t")) failures.push(`${path}:${index + 1}: tab character`);
  }
  if (path.endsWith(".json")) {
    try {
      JSON.parse(text);
    } catch (error) {
      failures.push(`${path}: invalid JSON: ${error.message}`);
    }
  }
}

for (const root of roots) await collect(root);
for (const file of files) {
  if (await exists(file)) await check(file);
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
