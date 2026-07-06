import { Flags } from "@oclif/core";

import { BaseCommand } from "../base-command.js";
import { bullet } from "../lib/format.js";

export default class Courses extends BaseCommand {
  static override aliases = ["course", "subjects", "subject"];
  static override summary = "List active Canvas subjects";
  static override description = "List active courses, hiding admin/onboarding shells by default.";
  static override examples = [
    "<%= config.bin %> courses",
    "<%= config.bin %> courses --all",
    "<%= config.bin %> subjects --json",
  ];
  static override flags = {
    all: Flags.boolean({ description: "include admin/onboarding shells", default: false }),
  };

  async run(): Promise<unknown> {
    const { flags } = await this.parse(Courses);
    const courses = await this.canvas.courses({ all: flags.all });
    const dto = courses.map((course) => ({
      id: course.id,
      code: course.code,
      name: course.name,
      term: course.term,
      score: course.score,
    }));

    if (!this.jsonEnabled()) {
      for (const course of dto) {
        this.log(bullet([course.code, course.name, `id ${course.id}`, course.term]));
      }
    }
    return dto;
  }
}
