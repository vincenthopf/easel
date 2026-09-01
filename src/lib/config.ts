import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { UserError } from "./errors.js";

export type ConfigSourceKind = "environment" | "project" | "user" | "none";

export interface ConfigSource {
  kind: ConfigSourceKind;
  path?: string;
}

export interface Config {
  baseUrl: string;
  canvasOrigin: string;
  token: string;
  libraryBaseUrl: string;
  minInterval: number;
  maxInterval: number;
  rpm: number;
  cacheDir: string;
  configDir: string;
  configSource: ConfigSource;
  requestTimeoutMs: number;
  retryLimit: number;
  maxRedirects: number;
  maxPages: number;
  maxItems: number;
  maxResponseBytes: number;
  maxDownloadBytes: number;
  lockTimeoutMs: number;
  allowInsecureLocalhost: boolean;
}

export interface LoadConfigOptions {
  requireToken?: boolean;
  environment?: Record<string, string | undefined>;
  cwd?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

interface ParsedSource {
  kind: ConfigSourceKind;
  path?: string;
  values: Record<string, string>;
}

interface CanvasRecord {
  baseUrl: string;
  token: string;
  source: ConfigSource;
}

export class ConfigError extends UserError {}

export function configDir(options: LoadConfigOptions = {}): string {
  const env = options.environment ?? process.env;
  const home = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const explicit = clean(env.EASEL_CONFIG_DIR);
  if (explicit) return explicit;
  if (platform === "win32") return join(clean(env.APPDATA) || join(home, "AppData", "Roaming"), "easel");
  if (platform === "darwin") return join(home, "Library", "Application Support", "easel");
  return join(clean(env.XDG_CONFIG_HOME) || join(home, ".config"), "easel");
}

export function configEnvPath(options: LoadConfigOptions = {}): string {
  return join(configDir(options), ".env");
}

export function configReadEnvPath(options: LoadConfigOptions = {}): string {
  const nativePath = configEnvPath(options);
  const environment = options.environment ?? process.env;
  if (clean(environment.EASEL_CONFIG_DIR)) return nativePath;
  const legacyPath = join(options.homeDir ?? homedir(), ".config", "easel", ".env");
  if (nativePath === legacyPath || existsSync(nativePath)) return nativePath;
  return existsSync(legacyPath) ? legacyPath : nativePath;
}

export function cacheDir(options: LoadConfigOptions = {}): string {
  const env = options.environment ?? process.env;
  const home = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const explicit = clean(env.EASEL_CACHE_DIR);
  if (explicit) return explicit;
  if (platform === "win32") return join(clean(env.LOCALAPPDATA) || join(home, "AppData", "Local"), "easel", "cache");
  if (platform === "darwin") return join(home, "Library", "Caches", "easel");
  return join(clean(env.XDG_CACHE_HOME) || join(home, ".cache"), "easel");
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const requireToken = options.requireToken ?? true;
  const environment = { ...(options.environment ?? process.env) };
  const cwd = options.cwd ?? process.cwd();
  const userPath = configReadEnvPath(options);
  const projectPath = join(cwd, ".env");
  const projectEnabled = booleanValue(environment.EASEL_PROJECT_CONFIG);
  const envSource: ParsedSource = { kind: "environment", values: definedValues(environment) };
  const projectSource: ParsedSource = {
    kind: "project",
    path: projectPath,
    values: requireToken || projectEnabled ? readEnvFile(projectPath) : {},
  };
  const userSource: ParsedSource = { kind: "user", path: userPath, values: readEnvFile(userPath) };
  const record = requireToken
    ? selectCanvasRecord(envSource, projectSource, userSource, projectEnabled, true)
    : { baseUrl: "", token: "", source: { kind: "none" as const } };
  const allowInsecureLocalhost = booleanValue(resolveValue("EASEL_ALLOW_INSECURE_LOCALHOST", envSource, projectSource, userSource, projectEnabled));
  const normalized = normalizeCanvasRecord(record.baseUrl, record.token, allowInsecureLocalhost, requireToken);
  const resolvedConfigDir = configDir(options);
  const resolvedCacheDir = cacheDir(options);

  ensurePrivateDirectory(resolvedConfigDir);
  ensurePrivateDirectory(resolvedCacheDir);

  const minInterval = positiveNumber(resolveValue("EASEL_MIN_INTERVAL", envSource, projectSource, userSource, projectEnabled), 0.7);
  const maxInterval = Math.max(
    minInterval,
    positiveNumber(resolveValue("EASEL_MAX_INTERVAL", envSource, projectSource, userSource, projectEnabled), 1.8),
  );

  return {
    baseUrl: normalized.baseUrl,
    canvasOrigin: normalized.canvasOrigin,
    token: normalized.token,
    libraryBaseUrl: normalizeOptionalPublicBase(
      resolveValue("LIBRARY_BASE_URL", envSource, projectSource, userSource, projectEnabled),
      allowInsecureLocalhost,
    ),
    minInterval,
    maxInterval,
    rpm: positiveInteger(resolveValue("EASEL_RPM", envSource, projectSource, userSource, projectEnabled), 40, 1, 10_000),
    cacheDir: resolvedCacheDir,
    configDir: resolvedConfigDir,
    configSource: record.source,
    requestTimeoutMs: positiveInteger(resolveValue("EASEL_REQUEST_TIMEOUT_MS", envSource, projectSource, userSource, projectEnabled), 15_000, 100, 300_000),
    retryLimit: nonNegativeInteger(resolveValue("EASEL_RETRY_LIMIT", envSource, projectSource, userSource, projectEnabled), 2, 10),
    maxRedirects: nonNegativeInteger(resolveValue("EASEL_MAX_REDIRECTS", envSource, projectSource, userSource, projectEnabled), 4, 20),
    maxPages: positiveInteger(resolveValue("EASEL_MAX_PAGES", envSource, projectSource, userSource, projectEnabled), 100, 1, 10_000),
    maxItems: positiveInteger(resolveValue("EASEL_MAX_ITEMS", envSource, projectSource, userSource, projectEnabled), 10_000, 1, 1_000_000),
    maxResponseBytes: positiveInteger(resolveValue("EASEL_MAX_RESPONSE_BYTES", envSource, projectSource, userSource, projectEnabled), 10 * 1024 * 1024, 1024, 100 * 1024 * 1024),
    maxDownloadBytes: positiveInteger(resolveValue("EASEL_MAX_DOWNLOAD_BYTES", envSource, projectSource, userSource, projectEnabled), 500 * 1024 * 1024, 1024, 10 * 1024 * 1024 * 1024),
    lockTimeoutMs: positiveInteger(resolveValue("EASEL_LOCK_TIMEOUT_MS", envSource, projectSource, userSource, projectEnabled), 10_000, 100, 120_000),
    allowInsecureLocalhost,
  };
}

export function canvasStateNamespace(config: Pick<Config, "canvasOrigin" | "token">): string {
  return createHash("sha256").update(config.canvasOrigin).update("\0").update(config.token).digest("hex").slice(0, 24);
}

export function validateCanvasRecord(
  baseUrl: string,
  token: string,
  allowInsecureLocalhost = false,
): { baseUrl: string; canvasOrigin: string; token: string } {
  return normalizeCanvasRecord(baseUrl, token, allowInsecureLocalhost, true);
}

export function parseEnv(text: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    output[key] = value;
  }
  return output;
}

export function serializeEnv(values: Record<string, string>): string {
  const ordered = [
    "CANVAS_BASE_URL",
    "CANVAS_TOKEN",
    "LIBRARY_BASE_URL",
    "EASEL_MIN_INTERVAL",
    "EASEL_MAX_INTERVAL",
    "EASEL_RPM",
    "EASEL_REQUEST_TIMEOUT_MS",
    "EASEL_RETRY_LIMIT",
    "EASEL_MAX_PAGES",
    "EASEL_MAX_ITEMS",
    "EASEL_MAX_DOWNLOAD_BYTES",
  ];
  const keys = [...ordered.filter((key) => values[key] !== undefined), ...Object.keys(values).filter((key) => !ordered.includes(key)).sort()];
  return `${keys.filter((key) => values[key] !== "").map((key) => `${key}=${values[key]}`).join("\n")}\n`;
}

function selectCanvasRecord(
  environment: ParsedSource,
  project: ParsedSource,
  user: ParsedSource,
  projectEnabled: boolean,
  requireToken: boolean,
): CanvasRecord {
  const environmentHasCanvas = hasCanvasValue(environment.values);
  if (environmentHasCanvas) return coherentRecord(environment, requireToken);

  const projectHasCanvas = hasCanvasValue(project.values);
  if (projectHasCanvas) {
    if (!projectEnabled) {
      throw new ConfigError(
        `Canvas settings were found in ${project.path}, but project configuration is disabled. ` +
          "Move the complete Canvas URL/token pair to the user config or set EASEL_PROJECT_CONFIG=1 for this invocation.",
      );
    }
    return coherentRecord(project, requireToken);
  }

  if (hasCanvasValue(user.values)) return coherentRecord(user, requireToken);
  if (requireToken) {
    throw new ConfigError(
      `No complete Canvas configuration was found. Run \`easel init\` or set both CANVAS_BASE_URL and CANVAS_TOKEN. User config: ${user.path}`,
    );
  }
  return { baseUrl: "", token: "", source: { kind: "none" } };
}

function coherentRecord(source: ParsedSource, requireToken: boolean): CanvasRecord {
  const baseUrl = clean(source.values.CANVAS_BASE_URL);
  const token = clean(source.values.CANVAS_TOKEN);
  if (Boolean(baseUrl) !== Boolean(token)) {
    throw new ConfigError(
      `Canvas configuration from ${sourceLabel(source)} is partial. CANVAS_BASE_URL and CANVAS_TOKEN must come from the same source.`,
    );
  }
  if (requireToken && (!baseUrl || !token)) {
    throw new ConfigError(`Canvas configuration from ${sourceLabel(source)} is incomplete.`);
  }
  return { baseUrl, token, source: { kind: source.kind, path: source.path } };
}

function normalizeCanvasRecord(
  rawBaseUrl: string,
  rawToken: string,
  allowInsecureLocalhost: boolean,
  required: boolean,
): { baseUrl: string; canvasOrigin: string; token: string } {
  const baseUrl = clean(rawBaseUrl).replace(/\/+$/, "");
  if (/[\r\n]/.test(rawToken)) throw new ConfigError("CANVAS_TOKEN must be a single-line value.");
  const token = clean(rawToken);
  if (!baseUrl && !token && !required) return { baseUrl: "", canvasOrigin: "", token: "" };
  if (!baseUrl || !token) throw new ConfigError("Canvas URL and token must be configured together.");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigError("CANVAS_BASE_URL must be an absolute URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError("CANVAS_BASE_URL cannot contain credentials, a query string, or a fragment.");
  }
  validateProtocol(url, allowInsecureLocalhost, "Canvas");
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname || "/";
  const normalized = url.toString().replace(/\/$/, "");
  return { baseUrl: normalized, canvasOrigin: url.origin, token };
}

function normalizeOptionalPublicBase(raw: string | undefined, allowInsecureLocalhost: boolean): string {
  const value = clean(raw).replace(/\/+$/, "");
  if (!value) return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("LIBRARY_BASE_URL must be an absolute URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError("LIBRARY_BASE_URL cannot contain credentials, a query string, or a fragment.");
  }
  validateProtocol(url, allowInsecureLocalhost, "Library");
  return url.toString().replace(/\/$/, "");
}

function validateProtocol(url: URL, allowInsecureLocalhost: boolean, label: string): void {
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && allowInsecureLocalhost && isLocalHostname(url.hostname)) return;
  throw new ConfigError(`${label} URLs must use HTTPS. HTTP is allowed only for localhost when EASEL_ALLOW_INSECURE_LOCALHOST=1.`);
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function resolveValue(
  name: string,
  environment: ParsedSource,
  project: ParsedSource,
  user: ParsedSource,
  projectEnabled: boolean,
): string | undefined {
  if (environment.values[name] !== undefined) return environment.values[name];
  if (projectEnabled && project.values[name] !== undefined) return project.values[name];
  return user.values[name];
}

function readEnvFile(path: string): Record<string, string> {
  try {
    if (!existsSync(path)) return {};
    return parseEnv(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`Unable to read configuration file ${path}.`, { cause: error });
  }
}

function ensurePrivateDirectory(path: string): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(path, 0o700);
  } catch (error) {
    throw new ConfigError(`Unable to create Easel directory ${path}.`, { cause: error });
  }
}

function sourceLabel(source: ParsedSource): string {
  return source.path ? `${source.kind} file ${source.path}` : source.kind;
}

function definedValues(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function hasCanvasValue(values: Record<string, string>): boolean {
  return values.CANVAS_BASE_URL !== undefined || values.CANVAS_TOKEN !== undefined;
}

function booleanValue(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(clean(value));
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number, maximum: number): number {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number >= 0 && number <= maximum ? number : fallback;
}
