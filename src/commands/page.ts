import { Args } from "@oclif/core";

import { BaseCommand, contentFlags, courseArg } from "../base-command.js";
import { extractCanvasFileLinks, htmlToText, renderContent } from "../lib/html.js";
import { sanitizeUrl } from "../lib/http.js";

export default class Page extends BaseCommand {
  static override aliases = ["p"];
  static override summary = "Fetch one Canvas page by module slug";
  static override description = "Fetch an individual Canvas page. Get page slugs from `easel modules`.";
  static override examples = [
    "<%= config.bin %> page BIO101 assessment-1-brief",
    "<%= config.bin %> page BIO101 assessment-1-brief --objective assessment",
    "<%= config.bin %> page 11111 a-page-slug -o page.txt",
  ];
  static override args = {
    course: Args.string(courseArg),
    slug: Args.string({ description: "page slug from a module item", required: true }),
  };
  static override flags = contentFlags;

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(Page);
    const course = await this.canvas.resolveCourse(args.course!);
    const page = await this.canvas.page(course.id, args.slug!);
    const text = htmlToText(page.body ?? "");
    const links = extractCanvasFileLinks(page.body ?? "", this.configData.baseUrl);
    const rendered = renderContent({ title: page.title, text }, flags);
    const dto = {
      course: course.code,
      courseId: course.id,
      slug: page.url,
      title: page.title,
      text: rendered,
      files: links.map((link) => ({
        courseId: link.courseId,
        fileId: link.fileId,
        hasVerifier: Boolean(link.verifier),
        label: link.label,
        url: sanitizeUrl(link.url),
      })),
    };
    if (!this.jsonEnabled()) {
      this.outputContent({ title: page.title, text, rendered, output: flags.output });
      if (!flags.output && links.length > 0) {
        this.log("");
        for (const link of links) this.log(`file ${link.courseId}/${link.fileId} · ${link.label ?? "Canvas file"}`);
      }
    }
    return dto;
  }
}
