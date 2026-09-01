import { mkdir, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const directory = resolve(".working/package");
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
await run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["pack", "--pack-destination", directory]);
const tarballs = (await readdir(directory)).filter((name) => name.endsWith(".tgz"));
if (tarballs.length !== 1) throw new Error(`expected one package tarball, found ${tarballs.length}`);
console.log(resolve(directory, tarballs[0]));

function run(command, arguments_) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0 && !signal) resolvePromise();
      else reject(new Error(`${command} failed with ${signal ?? code}`));
    });
  });
}
