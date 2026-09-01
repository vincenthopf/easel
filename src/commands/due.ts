import { Flags } from "@oclif/core";

import { BaseCommand } from "../base-command.js";
import { bullet, dateOnly, dueStatus, fmt } from "../lib/format.js";

export default class Due extends BaseCommand {
  static override aliases = ["assignments", "deadlines"];
  static override summary = "List upcoming assignments";
  static override description = "List assignments due soon across real subjects, with proctored Respondus and LockDown items flagged as hands-off.";
  static override examples = [
    "<%= config.bin %> due",
    "<%= config.bin %> due --days 30",
    "<%= config.bin %> due --course BIO101 --json",
  ];
  static override flags = {
    days: Flags.integer({ char: "d", description: "days ahead to include", default: 14, min: 1 }),
    course: Flags.string({ char: "c", description: "limit to one course code or id" }),
  };

  async run(): Promise<unknown> {
    const { flags } = await this.parse(Due);
    const items = await this.canvas.due(flags.days, flags.course);
    const dto = items.map(({ course, assignment, proctored, submitted, submittedAt, graded, excused, missing }) => ({
      course: course.code,
      courseId: course.id,
      id: assignment.id,
      name: assignment.name,
      dueAt: assignment.due_at,
      points: assignment.points_possible,
      quizId: assignment.quiz_id,
      proctored,
      submitted,
      submittedAt,
      graded,
      excused,
      missing,
    }));
    if (!this.jsonEnabled()) {
      if (dto.length === 0) this.log(`No assignments due in the next ${flags.days} days.`);
      for (const item of dto) {
        this.log(
          bullet([
            dateOnly(item.dueAt),
            dueStatus(item),
            item.course,
            item.name,
            item.points == null ? undefined : `${fmt(item.points)} pts`,
            item.proctored ? "PROCTORED hands-off" : undefined,
          ]),
        );
      }
    }
    return dto;
  }
}
