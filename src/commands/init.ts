import { existsSync, readFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";
import { Flags } from "@oclif/core";

import { BaseCommand } from "../base-command.js";
import { ConfigError, configEnvPath, configReadEnvPath, parseEnv, serializeEnv, validateCanvasRecord } from "../lib/config.js";
import { CanvasHttpClient } from "../lib/http.js";
import { atomicWriteFile } from "../lib/storage.js";

export default class Init extends BaseCommand {
  static override aliases = ["setup", "wizard"];
  static override summary = "Set up Canvas and optional library configuration";
  static override description =
    "Store one coherent Canvas URL/token pair in the native user config. Interactive token entry is hidden; automation can use CANVAS_TOKEN or --token-stdin.";
  static override examples = [
    "<%= config.bin %> init",
    "CANVAS_TOKEN=... <%= config.bin %> init --canvas-url https://canvas.example.edu --no-verify",
    "printf '%s' \"$CANVAS_TOKEN\" | <%= config.bin %> init --canvas-url https://canvas.example.edu --token-stdin",
  ];
  static override flags = {
    "canvas-url": Flags.string({ description: "Canvas base URL for non-interactive setup" }),
    "library-url": Flags.string({ description: "optional public library base URL" }),
    "token-stdin": Flags.boolean({ description: "read the Canvas token from standard input", default: false }),
    "no-verify": Flags.boolean({ description: "save without checking the Canvas profile endpoint", default: false }),
    "replace-host": Flags.boolean({ description: "allow non-interactive replacement of an existing Canvas host", default: false }),
  };

  protected override requiresCanvasToken(): boolean {
    return false;
  }

  async run(): Promise<unknown> {
    const { flags } = await this.parse(Init);
    const path = configEnvPath();
    const existingPath = configReadEnvPath();
    const existing = existsSync(existingPath) ? parseEnv(readFileSync(existingPath, "utf8")) : {};
    const interactive = !this.jsonEnabled() && Boolean(stdin.isTTY && stdout.isTTY);
    const values = interactive
      ? await interactiveValues(existing)
      : await nonInteractiveValues(existing, flags, process.env);
    const record = validateCanvasRecord(values.CANVAS_BASE_URL, values.CANVAS_TOKEN, this.configData.allowInsecureLocalhost);
    await enforceHostChange(existing.CANVAS_BASE_URL, record.baseUrl, interactive, flags["replace-host"]);

    if (!flags["no-verify"]) {
      const verificationConfig = {
        ...this.configData,
        baseUrl: record.baseUrl,
        canvasOrigin: record.canvasOrigin,
        token: record.token,
      };
      const verificationClient = new CanvasHttpClient(verificationConfig);
      const profile = await verificationClient.getJson<{ name?: string; primary_email?: string }>(
        verificationClient.canvasUrl("users/self/profile"),
      );
      const identity = profile.data.name ?? profile.data.primary_email ?? "your account";
      this.log(`Verified ${identity}.`);
    }

    const output: Record<string, string> = { ...existing, ...values, CANVAS_BASE_URL: record.baseUrl, CANVAS_TOKEN: record.token };
    if (!output.LIBRARY_BASE_URL) delete output.LIBRARY_BASE_URL;
    await atomicWriteFile(path, serializeEnv(output));
    this.log(`Saved private configuration to ${path}`);
    return { path, configured: true, source: "user", canvasOrigin: record.canvasOrigin, libraryConfigured: Boolean(output.LIBRARY_BASE_URL) };
  }
}

async function interactiveValues(existing: Record<string, string>): Promise<Record<string, string>> {
  stdout.write("easel setup\n");
  const baseUrl = normalizeUrl(await askLine("Canvas URL", existing.CANVAS_BASE_URL));
  stdout.write("Canvas token input is hidden. Press Enter to keep the configured token.\n");
  const enteredToken = await readHiddenInput(stdin, stdout, existing.CANVAS_TOKEN ? "Canvas access token [configured]: " : "Canvas access token: ");
  const token = enteredToken.trim() || existing.CANVAS_TOKEN || "";
  const libraryBaseUrl = normalizeUrl(await askLine("Library URL (optional)", existing.LIBRARY_BASE_URL));
  return { CANVAS_BASE_URL: baseUrl, CANVAS_TOKEN: token, LIBRARY_BASE_URL: libraryBaseUrl };
}

async function nonInteractiveValues(
  existing: Record<string, string>,
  flags: { "canvas-url"?: string; "library-url"?: string; "token-stdin": boolean },
  environment: Record<string, string | undefined>,
): Promise<Record<string, string>> {
  const baseUrl = normalizeUrl(flags["canvas-url"] ?? environment.CANVAS_BASE_URL ?? "");
  const stdinToken = flags["token-stdin"] ? (await readAllStdin()).trim() : "";
  const token = stdinToken || environment.CANVAS_TOKEN?.trim() || "";
  const libraryBaseUrl = normalizeUrl(flags["library-url"] ?? environment.LIBRARY_BASE_URL ?? existing.LIBRARY_BASE_URL ?? "");
  if (!baseUrl || !token) {
    throw new ConfigError(
      "Non-interactive setup requires --canvas-url and a token from CANVAS_TOKEN or --token-stdin. Tokens are not accepted as command-line arguments.",
    );
  }
  return { CANVAS_BASE_URL: baseUrl, CANVAS_TOKEN: token, LIBRARY_BASE_URL: libraryBaseUrl };
}

export async function readHiddenInput(input: ReadStream, output: WriteStream, prompt: string): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new ConfigError("Hidden token entry requires an interactive terminal. Use CANVAS_TOKEN or --token-stdin for automation.");
  }
  output.write(prompt);
  const previousRaw = input.isRaw;
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(Boolean(previousRaw));
      input.pause();
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\r" || character === "\n") {
          output.write("\n");
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u0003") {
          output.write("\n");
          cleanup();
          reject(new ConfigError("Setup cancelled."));
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function askLine(label: string, current?: string): Promise<string> {
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    const shown = current ? ` [${current}]` : "";
    const answer = await reader.question(`${label}${shown}: `);
    return answer.trim() || current || "";
  } finally {
    reader.close();
  }
}

async function readAllStdin(): Promise<string> {
  let output = "";
  for await (const chunk of stdin) output += chunk.toString();
  return output;
}

function normalizeUrl(value: string | undefined): string {
  let output = value?.trim().replace(/\/+$/, "") ?? "";
  if (output && !/^[a-z][a-z0-9+.-]*:\/\//i.test(output)) output = `https://${output}`;
  return output;
}

async function enforceHostChange(existing: string | undefined, next: string, interactive: boolean, replaceHost: boolean): Promise<void> {
  if (!existing || normalizeUrl(existing) === next) return;
  if (!interactive && !replaceHost) {
    throw new ConfigError("The Canvas host differs from the saved host. Re-run with --replace-host after verifying the new origin.");
  }
  if (interactive) {
    const answer = (await askLine(`Replace saved Canvas host ${normalizeUrl(existing)} with ${next}? Type yes to continue`)).toLowerCase();
    if (answer !== "yes") throw new ConfigError("Canvas host change cancelled.");
  }
}
