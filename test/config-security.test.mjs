import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ConfigError, canvasStateNamespace, configDir, configEnvPath, configReadEnvPath, loadConfig } from "../dist/lib/config.js";
import { workspace } from "./helpers.mjs";

function options(place, environment) {
  return { requireToken: true, environment, cwd: place.cwd, homeDir: place.root, platform: "linux" };
}

test("user config supplies one coherent Canvas credential record", async () => {
  const place = await workspace();
  try {
    await place.writeUserEnv({ CANVAS_BASE_URL: "https://canvas.user.example", CANVAS_TOKEN: "user-token" });
    const config = loadConfig(options(place, place.env));
    assert.equal(config.baseUrl, "https://canvas.user.example");
    assert.equal(config.token, "user-token");
    assert.equal(config.configSource.kind, "user");
  } finally {
    await place.cleanup();
  }
});

test("a hostile project URL cannot redirect a user-config token", async () => {
  const place = await workspace();
  try {
    await place.writeUserEnv({ CANVAS_BASE_URL: "https://canvas.user.example", CANVAS_TOKEN: "user-token" });
    await place.writeProjectEnv({ CANVAS_BASE_URL: "https://attacker.example" });
    assert.throws(() => loadConfig(options(place, place.env)), ConfigError);
  } finally {
    await place.cleanup();
  }
});

test("a project-only token is rejected without borrowing a lower-priority URL", async () => {
  const place = await workspace();
  try {
    await place.writeUserEnv({ CANVAS_BASE_URL: "https://canvas.user.example", CANVAS_TOKEN: "user-token" });
    await place.writeProjectEnv({ CANVAS_TOKEN: "project-token" });
    assert.throws(() => loadConfig(options(place, { ...place.env, EASEL_PROJECT_CONFIG: "1" })), ConfigError);
  } finally {
    await place.cleanup();
  }
});

test("a complete process-environment pair has highest priority", async () => {
  const place = await workspace();
  try {
    await place.writeUserEnv({ CANVAS_BASE_URL: "https://canvas.user.example", CANVAS_TOKEN: "user-token" });
    const environment = { ...place.env, CANVAS_BASE_URL: "https://canvas.environment.example", CANVAS_TOKEN: "environment-token" };
    const config = loadConfig(options(place, environment));
    assert.equal(config.baseUrl, "https://canvas.environment.example");
    assert.equal(config.token, "environment-token");
    assert.equal(config.configSource.kind, "environment");
  } finally {
    await place.cleanup();
  }
});

test("a partial process-environment pair is rejected", async () => {
  const place = await workspace();
  try {
    await place.writeUserEnv({ CANVAS_BASE_URL: "https://canvas.user.example", CANVAS_TOKEN: "user-token" });
    assert.throws(() => loadConfig(options(place, { ...place.env, CANVAS_BASE_URL: "https://canvas.environment.example" })), ConfigError);
    assert.throws(() => loadConfig(options(place, { ...place.env, CANVAS_TOKEN: "environment-token" })), ConfigError);
  } finally {
    await place.cleanup();
  }
});

test("project configuration requires explicit opt-in and a complete pair", async () => {
  const place = await workspace();
  try {
    await place.writeProjectEnv({ CANVAS_BASE_URL: "https://canvas.project.example", CANVAS_TOKEN: "project-token" });
    assert.throws(() => loadConfig(options(place, place.env)), ConfigError);
    const config = loadConfig(options(place, { ...place.env, EASEL_PROJECT_CONFIG: "1" }));
    assert.equal(config.baseUrl, "https://canvas.project.example");
    assert.equal(config.token, "project-token");
    assert.equal(config.configSource.kind, "project");
  } finally {
    await place.cleanup();
  }
});

test("configuration source switching never mutates the supplied environment", async () => {
  const place = await workspace();
  try {
    await place.writeUserEnv({ CANVAS_BASE_URL: "https://canvas.user.example", CANVAS_TOKEN: "user-token" });
    const environment = { ...place.env, CANVAS_BASE_URL: "https://canvas.environment.example", CANVAS_TOKEN: "environment-token" };
    const first = loadConfig(options(place, environment));
    delete environment.CANVAS_BASE_URL;
    delete environment.CANVAS_TOKEN;
    const second = loadConfig(options(place, environment));
    assert.equal(first.configSource.kind, "environment");
    assert.equal(second.configSource.kind, "user");
    assert.equal(second.baseUrl, "https://canvas.user.example");
  } finally {
    await place.cleanup();
  }
});

test("missing Canvas credentials fail clearly", async () => {
  const place = await workspace();
  try {
    assert.throws(() => loadConfig(options(place, place.env)), ConfigError);
  } finally {
    await place.cleanup();
  }
});

test("Windows configuration and cache locations are native", () => {
  const path = configDir({ environment: { APPDATA: "C:\\Users\\student\\AppData\\Roaming" }, homeDir: "C:\\Users\\student", platform: "win32" });
  assert.match(path, /AppData[\\/]Roaming[\\/]easel$/);
});

test("credential namespaces change across host and account switches without exposing tokens", () => {
  const one = canvasStateNamespace({ canvasOrigin: "https://one.example", token: "first-secret" });
  const two = canvasStateNamespace({ canvasOrigin: "https://two.example", token: "first-secret" });
  const three = canvasStateNamespace({ canvasOrigin: "https://one.example", token: "second-secret" });
  assert.notEqual(one, two);
  assert.notEqual(one, three);
  assert.doesNotMatch(one, /first|secret/);
});

test("created user directories are private", async () => {
  const place = await workspace();
  try {
    await place.writeUserEnv({ CANVAS_BASE_URL: "https://canvas.user.example", CANVAS_TOKEN: "user-token" });
    loadConfig(options(place, place.env));
    const mode = (await stat(join(place.config, "easel"))).mode & 0o777;
    assert.equal(mode & 0o077, 0);
  } finally {
    await place.cleanup();
  }
});

test("non-Canvas configuration ignores partial environment and disabled project credentials", async () => {
  const place = await workspace();
  try {
    await place.writeUserEnv({
      CANVAS_BASE_URL: "https://canvas.user.example",
      CANVAS_TOKEN: "user-token",
      LIBRARY_BASE_URL: "https://library.user.example",
    });
    await place.writeProjectEnv({ CANVAS_BASE_URL: "https://attacker.example" });
    const config = loadConfig({ ...options(place, { ...place.env, CANVAS_TOKEN: "setup-token" }), requireToken: false });
    assert.equal(config.baseUrl, "");
    assert.equal(config.token, "");
    assert.equal(config.configSource.kind, "none");
    assert.equal(config.libraryBaseUrl, "https://library.user.example");
  } finally {
    await place.cleanup();
  }
});

test("tokens must be single-line values", async () => {
  const place = await workspace();
  try {
    assert.throws(
      () => loadConfig(options(place, {
        ...place.env,
        CANVAS_BASE_URL: "https://canvas.environment.example",
        CANVAS_TOKEN: "first-line\nSECOND=value",
      })),
      ConfigError,
    );
  } finally {
    await place.cleanup();
  }
});

test("macOS reads the legacy user config until the native path is migrated", async () => {
  const place = await workspace();
  try {
    const legacy = join(place.root, ".config", "easel", ".env");
    await mkdir(join(place.root, ".config", "easel"), { recursive: true });
    await writeFile(legacy, "CANVAS_BASE_URL=https://canvas.legacy.example\nCANVAS_TOKEN=legacy-token\n", { mode: 0o600 });
    const loadOptions = { requireToken: true, environment: place.env, cwd: place.cwd, homeDir: place.root, platform: "darwin" };
    const config = loadConfig(loadOptions);
    assert.equal(config.baseUrl, "https://canvas.legacy.example");
    assert.equal(config.configSource.path, legacy);
    assert.equal(configReadEnvPath(loadOptions), legacy);
    assert.notEqual(configEnvPath(loadOptions), legacy);
  } finally {
    await place.cleanup();
  }
});
