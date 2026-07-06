import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { once } from "node:events";
import { stdin as input, stdout as output } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";

import { BaseCommand } from "../base-command.js";
import { configEnvPath } from "../lib/config.js";

export default class Init extends BaseCommand {
  static override aliases = ["setup", "wizard"];
  static override summary = "Set up your Canvas token and settings (interactive)";
  static override description =
    "Walks you through connecting easel to your Canvas: your Canvas URL, a personal access token, " +
    "and (optionally) your library URL. Saves everything to a private config file so easel works from any folder.";
  static override examples = ["<%= config.bin %> init"];

  protected override requiresCanvasToken(): boolean {
    return false;
  }

  async run(): Promise<unknown> {
    await this.parse(Init);
    const path = configEnvPath();
    const existing = existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};

    const rl = createInterface({ input, output });
    let env: Record<string, string>;
    try {
      this.log("easel setup — press Enter to keep the [current] value.\n");

      const baseUrl = normalizeUrl(
        await ask(rl, "Canvas URL (e.g. https://canvas.youruni.edu)", existing.CANVAS_BASE_URL),
      );
      this.log("  Token: Canvas → Account → Settings → New Access Token");
      const token = (await ask(rl, "Canvas access token", existing.CANVAS_TOKEN)).trim();
      const libraryBaseUrl = normalizeUrl(
        await ask(rl, "Library URL (optional, for `easel library`)", existing.LIBRARY_BASE_URL ?? ""),
      );

      env = { ...existing, CANVAS_BASE_URL: baseUrl, CANVAS_TOKEN: token };
      if (libraryBaseUrl) env.LIBRARY_BASE_URL = libraryBaseUrl;
      else delete env.LIBRARY_BASE_URL;
    } finally {
      rl.close();
    }

    await writeFile(path, serializeEnv(env), { mode: 0o600 });
    this.log(`\nSaved to ${path}`);

    if (env.CANVAS_BASE_URL && env.CANVAS_TOKEN) {
      const who = await verify(env.CANVAS_BASE_URL, env.CANVAS_TOKEN);
      if (who) this.log(`Connected as ${who}. You're set — try \`easel today\`.`);
      else this.log("Couldn't verify that token — check the URL and token, then run `easel init` again.");
    }

    return { path, configured: Boolean(env.CANVAS_TOKEN) };
  }
}

async function ask(rl: Interface, label: string, current?: string): Promise<string> {
  const shown = current ? ` [${mask(label, current)}]` : "";
  let answer = "";
  try {
    // Resolve on EOF/Ctrl-D instead of hanging on an unsettled await.
    answer = await Promise.race([
      rl.question(`${label}${shown}: `),
      once(rl, "close").then(() => ""),
    ]);
  } catch {
    answer = "";
  }
  return answer.trim() || current || "";
}

function mask(label: string, value: string): string {
  if (/token/i.test(label) && value.length > 8) return `${value.slice(0, 4)}…${value.slice(-2)}`;
  return value;
}

function normalizeUrl(raw: string): string {
  let s = raw.trim().replace(/\/+$/, "");
  if (s && !/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s;
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function serializeEnv(env: Record<string, string>): string {
  const lines = [
    "# easel configuration — written by `easel init`. Keep this file private.",
    "",
  ];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === "") continue;
    lines.push(`${key}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}

async function verify(baseUrl: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/users/self/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { name?: string; primary_email?: string };
    return data.name ?? data.primary_email ?? "your account";
  } catch {
    return null;
  }
}
