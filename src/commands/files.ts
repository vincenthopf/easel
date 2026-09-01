import { Args, Flags } from "@oclif/core";

import { BaseCommand, courseArg } from "../base-command.js";
import { bullet } from "../lib/format.js";
import { sanitizeUrl } from "../lib/http.js";

export default class Files extends BaseCommand {
  static override aliases = ["file", "attachments"];
  static override summary = "Find downloadable Canvas files in course content";
  static override description = "Find files from module File items and links embedded in assignments, announcements, and pages.";
  static override examples = [
    "<%= config.bin %> files BIO101",
    "<%= config.bin %> files BIO101 --limit 50",
    "<%= config.bin %> attachments 11111 --json",
  ];
  static override args = { course: Args.string({ ...courseArg, required: false }) };
  static override flags = {
    limit: Flags.integer({ char: "n", description: "maximum file references to print; JSON returns all", default: 25, min: 1 }),
  };

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(Files);
    const files = await this.canvas.findFiles(args.course);
    const dto = files.map((file) => ({
      course: file.course.code,
      courseId: file.course.id,
      fileId: file.link.fileId,
      hasVerifier: Boolean(file.link.verifier),
      source: file.source,
      title: file.title,
      label: file.link.label,
      ref: `${file.link.courseId}/${file.link.fileId}`,
      url: sanitizeUrl(file.link.url),
    }));
    if (!this.jsonEnabled()) {
      if (dto.length === 0) this.log("No Canvas files found.");
      for (const item of dto.slice(0, flags.limit)) this.log(bullet([item.course, `file ${item.ref}`, item.source, item.label ?? item.title]));
      if (dto.length > flags.limit) this.log(`… ${dto.length - flags.limit} more; use --limit ${dto.length} or --json for all.`);
    }
    return dto;
  }
}
