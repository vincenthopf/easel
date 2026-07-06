import { Args, Flags } from "@oclif/core";

import { BaseCommand, courseArg } from "../base-command.js";
import { bullet, shortDate } from "../lib/format.js";
import { htmlToText, truncate } from "../lib/html.js";

export default class Discussions extends BaseCommand {
  static override aliases = ["discussion", "disc"];
  static override summary = "List discussion topics for a course";
  static override description = "List Canvas discussion topics for one course.";
  static override examples = [
    "<%= config.bin %> discussions BIO101",
    "<%= config.bin %> disc 22222 --limit 5",
    "<%= config.bin %> discussions CHEM101 --json",
  ];
  static override args = {
    course: Args.string(courseArg),
  };
  static override flags = {
    limit: Flags.integer({ char: "n", description: "maximum discussions to print", default: 20, min: 1 }),
  };

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(Discussions);
    const course = await this.canvas.resolveCourse(args.course!);
    const topics = (await this.canvas.discussions(course.id)).slice(0, flags.limit);
    const dto = topics.map((topic) => ({
      id: topic.id,
      course: course.code,
      courseId: course.id,
      title: topic.title,
      postedAt: topic.posted_at,
      lastReplyAt: topic.last_reply_at,
      replies: topic.discussion_subentry_count ?? 0,
      locked: topic.locked ?? false,
      excerpt: truncate(htmlToText(topic.message ?? ""), 180),
      url: topic.html_url,
    }));

    if (!this.jsonEnabled()) {
      if (dto.length === 0) this.log(`No discussions found for ${course.code}.`);
      for (const item of dto) {
        this.log(bullet([shortDate(item.lastReplyAt ?? item.postedAt), item.title, `${item.replies} replies`, item.locked ? "locked" : undefined, item.excerpt]));
      }
    }
    return dto;
  }
}
