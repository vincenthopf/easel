import { Args } from "@oclif/core";

import { BaseCommand } from "../../base-command.js";
import { bullet } from "../../lib/format.js";
import { LibraryClient } from "../../lib/library.js";

export default class LibrarySearch extends BaseCommand {
  static override aliases = ["lib search", "library s"];
  static override summary = "Search the configured public library site";
  static override description = "Search generic public library pages without sending a Canvas token or institution-specific identifiers.";
  static override examples = [
    "<%= config.bin %> library search referencing",
    "<%= config.bin %> lib search academic writing",
    "<%= config.bin %> library search referencing --json",
  ];
  static override args = { query: Args.string({ description: "search query", required: true }) };

  protected override requiresCanvasToken(): boolean {
    return false;
  }

  async run(): Promise<unknown> {
    const { args } = await this.parse(LibrarySearch);
    const results = await new LibraryClient(this.configData).search(args.query);
    const dto = results.map((result) => ({ title: result.title, url: result.url, excerpt: result.excerpt }));
    if (!this.jsonEnabled()) {
      if (dto.length === 0) this.log("No library results found.");
      for (const result of dto) this.log(bullet([result.title, result.url, result.excerpt]));
    }
    return dto;
  }
}
