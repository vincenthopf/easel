import { BaseCommand } from "../base-command.js";

export default class Library extends BaseCommand {
  static override aliases = ["lib"];
  static override summary = "Search and fetch the public library";
  static override description = "Use `library search` or `library fetch`. Library requests need no Canvas token but still use the shared rate limiter.";
  static override examples = [
    "<%= config.bin %> library search referencing",
    "<%= config.bin %> library fetch https://library.example.edu",
  ];

  protected override requiresCanvasToken(): boolean {
    return false;
  }

  async run(): Promise<unknown> {
    await this.parse(Library);
    this.log("Use `easel library search <q>` or `easel library fetch <url>`.");
    return { commands: ["library search", "library fetch"] };
  }
}
