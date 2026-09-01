import { createServer } from "node:http";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const packageDirectory = resolve(".working/package");
const tarballName = (await readdir(packageDirectory)).find((name) => name.endsWith(".tgz"));
if (!tarballName) throw new Error("package tarball not found; run pnpm pack:artifact first");
const tarball = join(packageDirectory, tarballName);
const listing = await run("tar", ["-tf", tarball]);
for (const required of ["package/package.json", "package/PROJECT.txt", "package/dist/entry.js"]) {
  if (!listing.stdout.includes(required)) throw new Error(`package is missing ${required}`);
}
for (const forbidden of ["package/.env", "package/src/", "package/test/", "package/.working/"]) {
  if (listing.stdout.includes(forbidden)) throw new Error(`package contains forbidden path ${forbidden}`);
}

const root = await mkdtemp(join(tmpdir(), "easel-package-smoke-"));
const prefix = join(root, "prefix");
const cache = join(root, "cache");
const config = join(root, "config");
try {
  const npmCli = await findNpmCli();
  await run(process.execPath, [npmCli, "install", "-g", "--prefix", prefix, tarball]);
  const executable = process.platform === "win32" ? join(prefix, "easel.cmd") : join(prefix, "bin", "easel");
  await run(executable, ["--help"], { EASEL_NO_UPDATE_CHECK: "1" });
  await run(executable, ["--version"], { EASEL_NO_UPDATE_CHECK: "1" });
  const bug = await run(executable, ["bug", "--json"], { EASEL_NO_UPDATE_CHECK: "1" });
  const bugData = JSON.parse(bug.stdout);
  if (!String(bugData.url).includes("bugreport")) throw new Error("bug JSON contract failed");

  let authorization;
  const server = createServer((request, response) => {
    authorization = request.headers.authorization;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: 123, name: "Package Smoke", primary_email: "smoke@example.invalid" }));
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server did not bind");
  try {
    const whoami = await run(executable, ["whoami", "--json"], {
      EASEL_NO_UPDATE_CHECK: "1",
      EASEL_ALLOW_INSECURE_LOCALHOST: "1",
      EASEL_CACHE_DIR: cache,
      EASEL_CONFIG_DIR: config,
      EASEL_MIN_INTERVAL: "0.001",
      EASEL_MAX_INTERVAL: "0.001",
      EASEL_RPM: "10000",
      CANVAS_BASE_URL: `http://127.0.0.1:${address.port}`,
      CANVAS_TOKEN: "package-smoke-token",
    });
    const profile = JSON.parse(whoami.stdout);
    if (profile.id !== 123) throw new Error("mock-backed whoami JSON contract failed");
    if (authorization !== "Bearer package-smoke-token") throw new Error("mock-backed whoami authorization failed");
  } finally {
    await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

async function run(command, arguments_, additions = {}) {
  return new Promise((resolvePromise, reject) => {
    const environment = {
      ...process.env,
      PATH: `${process.env.PATH ?? ""}${delimiter}${join(process.cwd(), "node_modules", ".bin")}`,
      ...additions,
    };
    const shell = process.platform === "win32" && command.toLowerCase().endsWith(".cmd");
    const child = spawn(command, arguments_, { env: environment, shell, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0 && !signal) resolvePromise({ stdout, stderr });
      else reject(new Error(`${command} ${arguments_.join(" ")} failed with ${signal ?? code}\n${stdout}\n${stderr}`));
    });
  });
}

async function findNpmCli() {
  const executableDirectory = dirname(process.execPath);
  const candidates = process.platform === "win32"
    ? [join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js")]
    : [
        join(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
        join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
      ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`npm CLI was not found beside ${process.execPath}`);
}
