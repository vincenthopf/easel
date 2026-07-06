import { Flags } from "@oclif/core";

import { BaseCommand } from "../base-command.js";
import { bullet, passFail, percent, points } from "../lib/format.js";

export default class Marks extends BaseCommand {
  static override aliases = ["grades", "grade"];
  static override summary = "Show submitted marks and weighted current grade";
  static override description = "Show marked/submitted assessments with a 50% pass-line read. Per-question quiz review is intentionally not attempted.";
  static override examples = [
    "<%= config.bin %> marks",
    "<%= config.bin %> marks --course CHEM101",
    "<%= config.bin %> grades --json",
  ];
  static override flags = {
    course: Flags.string({ char: "c", description: "limit to one course code or id" }),
  };

  async run(): Promise<unknown> {
    const { flags } = await this.parse(Marks);
    const result = await this.canvas.marks(flags.course);
    const dto = {
      projections: result.projections.map((projection) => ({
        course: projection.course.code,
        courseId: projection.course.id,
        currentGrade: projection.currentGrade == null ? null : Number(projection.currentGrade.toFixed(2)),
        finalLockedIn: projection.finalLockedIn == null ? null : Number(projection.finalLockedIn.toFixed(2)),
        groups: projection.groups.map((group) => ({
          name: group.name,
          weight: group.weight,
          earned: group.earned,
          possible: group.possible,
          percent: group.percent == null ? null : Number(group.percent.toFixed(2)),
        })),
      })),
      marks: result.items.map(({ course, assignment, submission, proctored }) => ({
        course: course.code,
        courseId: course.id,
        assignmentId: assignment?.id ?? submission.assignment_id,
        name: assignment?.name ?? `assignment ${submission.assignment_id}`,
        score: submission.score,
        points: assignment?.points_possible,
        percent: submission.score != null && assignment?.points_possible ? Number(((submission.score / assignment.points_possible) * 100).toFixed(2)) : null,
        submittedAt: submission.submitted_at,
        grade: submission.grade,
        workflowState: submission.workflow_state,
        proctored,
      })),
    };

    if (!this.jsonEnabled()) {
      for (const projection of result.projections) {
        const value =
          projection.currentGrade == null || projection.finalLockedIn == null
            ? "no marks yet"
            : `${projection.currentGrade.toFixed(1)}% current grade (graded so far) · ${projection.finalLockedIn.toFixed(1)}% of final locked in`;
        this.log(`${projection.course.code} · ${value}`);
      }
      for (const item of result.items) {
        this.log(
          bullet([
            item.course.code,
            item.assignment?.name,
            points(item.submission.score, item.assignment?.points_possible),
            percent(item.submission.score, item.assignment?.points_possible),
            passFail(item.submission.score, item.assignment?.points_possible),
            item.proctored ? "PROCTORED hands-off" : undefined,
            item.submission.grade && item.submission.score == null ? `grade ${item.submission.grade}` : undefined,
          ]),
        );
      }
      if (result.items.length === 0) this.log("No submitted or marked assessments found.");
    }
    return dto;
  }
}
