import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../test", import.meta.url));
const files = [];

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.name.endsWith(".test.mjs")) files.push(path);
  }
}

await collect(root);
files.sort();
const child = spawn(process.execPath, ["--test", ...files], { stdio: "inherit" });
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`test runner terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
