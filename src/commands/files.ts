import { Args, Flags } from "@oclif/core";

import { BaseCommand, courseArg } from "../base-command.js";
import { bullet } from "../lib/format.js";

export default class Files extends BaseCommand {
  static override aliases = ["file", "attachments"];
  static override summary = "Find downloadable Canvas file links in course content";
  static override description = "Find file links embedded in assignment descriptions, announcements, and page bodies. Canvas file indexes are not used because many institutions block them.";
  static override examples = [
    "<%= config.bin %> files BIO101",
    "<%= config.bin %> files BIO101 --limit 50",
    "<%= config.bin %> attachments 11111 --json",
  ];
  static override args = {
    course: Args.string({ ...courseArg, required: false }),
  };
  static override flags = {
    limit: Flags.integer({ char: "n", description: "maximum file links to print; JSON still returns all", default: 25, min: 1 }),
  };

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(Files);
    const files = await this.canvas.findFiles(args.course);
    const dto = files.map((file) => ({
      course: file.course.code,
      courseId: file.course.id,
      fileId: file.link.fileId,
      verifier: file.link.verifier,
      source: file.source,
      title: file.title,
      label: file.link.label,
      ref: `${file.link.courseId}/${file.link.fileId}`,
      url: file.link.url,
    }));

    if (!this.jsonEnabled()) {
      if (dto.length === 0) this.log("No embedded Canvas file links found.");
      for (const item of dto.slice(0, flags.limit)) {
        this.log(bullet([item.course, `file ${item.ref}`, item.source, item.label ?? item.title, item.verifier ? "verifier" : undefined]));
      }
      if (dto.length > flags.limit) this.log(`… ${dto.length - flags.limit} more; use --limit ${dto.length} or --json for all.`);
    }
    return dto;
  }
}
