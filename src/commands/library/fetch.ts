import { Args } from "@oclif/core";

import { BaseCommand, contentFlags } from "../../base-command.js";
import { renderContent, writeOutputFile } from "../../lib/html.js";
import { LibraryClient } from "../../lib/library.js";

export default class LibraryFetch extends BaseCommand {
  static override aliases = ["lib fetch", "library f"];
  static override summary = "Fetch one public library page as clean text";
  static override description = "Fetch a public library URL without a Canvas token. Use --objective for focused passages, --full for all text, or -o to write full text to a file.";
  static override examples = [
    "<%= config.bin %> library fetch https://library.example.edu/ld.php?content_id=...",
    "<%= config.bin %> library fetch https://library.example.edu --objective referencing",
    "<%= config.bin %> library fetch https://library.example.edu -o library.txt",
  ];
  static override args = {
    url: Args.string({ description: "library URL", required: true }),
  };
  static override flags = contentFlags;

  protected override requiresCanvasToken(): boolean {
    return false;
  }

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(LibraryFetch);
    const library = new LibraryClient(this.configData);
    const page = await library.fetch(args.url);
    const rendered = renderContent({ title: page.title, text: page.text }, flags);
    const dto = {
      title: page.title,
      url: page.url,
      bytes: page.bytes,
      text: rendered,
    };

    if (!this.jsonEnabled()) {
      if (flags.output) {
        const saved = writeOutputFile(flags.output, page.text);
        this.log(`${saved.path} · ${saved.bytes} bytes${page.title ? ` · ${page.title}` : ""}`);
      } else {
        this.log(rendered);
      }
    }
    return dto;
  }
}
