import { Command, Flags } from "@oclif/core";

import { AGENT_BUG_POINTER } from "./lib/agent-messages.js";
import { CanvasClient } from "./lib/canvas.js";
import { ConfigError, loadConfig } from "./lib/config.js";
import type { Config } from "./lib/config.js";
import { HttpError } from "./lib/http.js";
import { writeOutputFile } from "./lib/html.js";
import { startUpdateCheck } from "./lib/update-check.js";

export abstract class BaseCommand extends Command {
  static override enableJsonFlag = true;

  protected configData!: Config;
  protected canvas!: CanvasClient;

  protected override async init(): Promise<void> {
    await super.init();
    startUpdateCheck(this.config);
    try {
      this.configData = loadConfig({ requireToken: this.requiresCanvasToken() });
      this.canvas = new CanvasClient(this.configData);
    } catch (error) {
      if (error instanceof ConfigError) this.error(error.message);
      throw error;
    }
  }

  protected requiresCanvasToken(): boolean {
    return true;
  }

  protected contentFlags() {
    return contentFlags;
  }

  protected outputContent(params: {
    title?: string;
    text: string;
    rendered: string;
    output?: string;
  }): void {
    if (params.output) {
      const saved = writeOutputFile(params.output, params.text);
      this.log(`${saved.path} · ${saved.bytes} bytes${params.title ? ` · ${params.title}` : ""}`);
      return;
    }
    this.log(params.rendered);
  }

  protected rateLimitSummary(): string {
    const info = this.canvas.http.limiter.info();
    return `rate limit: ${info.minInterval}-${info.maxInterval}s gap, ${info.rpm} rpm, state ${info.statePath}`;
  }

  protected override async catch(error: Error & { exitCode?: number }): Promise<void> {
    this.logToStderr(AGENT_BUG_POINTER);
    if (error instanceof HttpError) {
      this.error(error.message, { exit: error.status >= 500 ? 2 : 1 });
    }
    return super.catch(error);
  }
}

export const contentFlags = {
  full: Flags.boolean({
    char: "f",
    description: "return full content instead of a compact excerpt",
    default: false,
  }),
  objective: Flags.string({
    description: "focus long content on this topic",
  }),
  output: Flags.string({
    char: "o",
    description: "write full content to a file and print only a short summary",
  }),
};

export const courseArg = {
  description: "course code or numeric Canvas course id",
  required: true,
};
