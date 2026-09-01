import { BaseCommand } from "../base-command.js";
import { bullet, dateOnly, daysUntil, shortDate } from "../lib/format.js";
import { htmlToText, truncate } from "../lib/html.js";

export default class Today extends BaseCommand {
  static override aliases = ["brief", "now"];
  static override summary = "Compact study briefing for today";
  static override description = "Show urgent due work, Canvas-reported missing submissions, and recent announcements.";
  static override examples = ["<%= config.bin %> today", "<%= config.bin %> brief --json"];

  async run(): Promise<unknown> {
    await this.parse(Today);
    const courses = await this.canvas.courses();
    const byId = new Map(courses.map((course) => [course.id, course]));
    const [due, missing, announcements] = await Promise.all([
      this.canvas.due(7),
      this.canvas.missingSubmissions(),
      this.canvas.announcements(courses.map((course) => course.id)),
    ]);
    const recentAnnouncements = announcements
      .sort((left, right) => String(right.posted_at ?? right.delayed_post_at).localeCompare(String(left.posted_at ?? left.delayed_post_at)))
      .slice(0, 5)
      .map((item) => {
        const courseId = Number(item.context_code?.replace("course_", ""));
        return {
          id: item.id,
          course: byId.get(courseId)?.code ?? item.context_code,
          title: item.title,
          postedAt: item.posted_at ?? item.delayed_post_at,
          excerpt: truncate(htmlToText(item.message ?? ""), 140),
        };
      });
    const dueDto = due.map(({ course, assignment, proctored, submitted, submittedAt, graded, excused, missing: reportedMissing }) => ({
      course: course.code,
      courseId: course.id,
      id: assignment.id,
      name: assignment.name,
      dueAt: assignment.due_at,
      points: assignment.points_possible,
      proctored,
      submitted,
      submittedAt,
      graded,
      excused,
      missing: reportedMissing,
    }));
    const dto = {
      due: dueDto.filter((item) => !item.submitted && !item.excused).slice(0, 10),
      submittedDue: dueDto.filter((item) => item.submitted || item.excused),
      missing: missing.slice(0, 10).map((item) => ({
        id: item.id,
        course: byId.get(item.course_id)?.code ?? String(item.course_id),
        courseId: item.course_id,
        name: item.name,
        dueAt: item.due_at,
        points: item.points_possible,
      })),
      announcements: recentAnnouncements,
    };
    if (!this.jsonEnabled()) {
      this.log("Due soon");
      if (dto.due.length === 0) this.log("  nothing due in the next 7 days");
      for (const item of dto.due) this.log(`  ${bullet([dateOnly(item.dueAt), daysUntil(item.dueAt), item.course, item.name, item.proctored ? "PROCTORED hands-off" : undefined])}`);
      this.log("Missing");
      if (dto.missing.length === 0) this.log("  no missing submissions reported by Canvas");
      for (const item of dto.missing) this.log(`  ${bullet([dateOnly(item.dueAt), item.course, item.name])}`);
      this.log("Announcements");
      if (dto.announcements.length === 0) this.log("  none found");
      for (const item of dto.announcements) this.log(`  ${bullet([shortDate(item.postedAt), item.course, item.title])}`);
    }
    return dto;
  }
}
