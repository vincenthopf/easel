import { Flags } from "@oclif/core";

import { BaseCommand } from "../base-command.js";
import { bullet, shortDate } from "../lib/format.js";
import { htmlToText, truncate } from "../lib/html.js";

export default class Announcements extends BaseCommand {
  static override aliases = ["announce", "ann"];
  static override summary = "List recent Canvas announcements";
  static override description = "List announcements across real subjects by default, or one course when --course is supplied.";
  static override examples = [
    "<%= config.bin %> announcements",
    "<%= config.bin %> ann --course BIO101",
    "<%= config.bin %> announcements --limit 20 --json",
  ];
  static override flags = {
    course: Flags.string({ char: "c", description: "limit to one course code or id" }),
    limit: Flags.integer({ char: "n", description: "maximum announcements to print", default: 12, min: 1 }),
  };

  async run(): Promise<unknown> {
    const { flags } = await this.parse(Announcements);
    const courses = flags.course ? [await this.canvas.resolveCourse(flags.course)] : await this.canvas.courses();
    const byId = new Map(courses.map((course) => [course.id, course]));
    const items = (await this.canvas.announcements(courses.map((course) => course.id)))
      .sort((a, b) => String(b.posted_at ?? b.delayed_post_at).localeCompare(String(a.posted_at ?? a.delayed_post_at)))
      .slice(0, flags.limit);
    const dto = items.map((item) => {
      const courseId = Number(item.context_code?.replace("course_", ""));
      return {
        id: item.id,
        course: byId.get(courseId)?.code ?? item.context_code,
        courseId: Number.isFinite(courseId) ? courseId : undefined,
        title: item.title,
        postedAt: item.posted_at ?? item.delayed_post_at,
        excerpt: truncate(htmlToText(item.message ?? ""), 180),
        url: item.html_url,
      };
    });

    if (!this.jsonEnabled()) {
      if (dto.length === 0) this.log("No announcements found.");
      for (const item of dto) {
        this.log(bullet([shortDate(item.postedAt), item.course, item.title, item.excerpt]));
      }
    }
    return dto;
  }
}
