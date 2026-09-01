import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Config } from "./config.js";
import { canvasStateNamespace } from "./config.js";
import type {
  Announcement,
  Assignment,
  AssignmentGroup,
  CanvasCourse,
  CanvasFileMeta,
  CanvasPage,
  CanvasProfile,
  CourseModule,
  DiscussionTopic,
  MissingSubmission,
  Submission,
} from "./canvas-types.js";
import { UserError } from "./errors.js";
import { extractCanvasFileLinks, htmlToText, singleLine } from "./html.js";
import type { FileLink } from "./html.js";
import { CanvasHttpClient, HttpError } from "./http.js";
import { writeJsonFileSync } from "./storage.js";

const COURSE_CACHE_MS = 5 * 60_000;

export interface CourseRef {
  id: number;
  code: string;
  name: string;
  term?: string;
  score?: number | null;
}

export interface DueItem {
  course: CourseRef;
  assignment: Assignment;
  proctored: boolean;
  submitted: boolean;
  submittedAt: string | null;
  graded: boolean;
  excused: boolean;
  missing: boolean;
}

export interface MarkItem {
  course: CourseRef;
  submission: Submission;
  assignment?: Assignment;
  proctored: boolean;
}

export type GradeBasis = "canvas" | "simple-weighted" | "points" | "unavailable";

export interface WeightedProjection {
  course: CourseRef;
  currentGrade?: number;
  finalLockedIn?: number;
  basis: GradeBasis;
  limitations: string[];
  groups: Array<{
    name: string;
    weight: number;
    earned?: number;
    possible?: number;
    percent?: number;
    dropRules: boolean;
  }>;
}

export interface FoundFile {
  course: CourseRef;
  source: string;
  title: string;
  link: FileLink;
}

export class CourseReferenceError extends UserError {}
export class CanvasFeatureUnavailableError extends UserError {}

export class CanvasClient {
  readonly http: CanvasHttpClient;

  constructor(readonly config: Config) {
    this.http = new CanvasHttpClient(config);
  }

  async profile(): Promise<CanvasProfile> {
    return (await this.http.getJson<CanvasProfile>(this.http.canvasUrl("users/self/profile"))).data;
  }

  async courses(options: { all?: boolean; cached?: boolean } = {}): Promise<CourseRef[]> {
    const cached = options.cached ?? true;
    if (cached) {
      const hit = this.readCourseCache();
      if (hit) return hit;
    }
    const path = `courses?${query({
      enrollment_state: "active",
      "include[]": ["term", "total_scores"],
      per_page: 100,
    })}`;
    const raw = await this.http.getPaginated<CanvasCourse>(this.http.canvasUrl(path));
    const refs = raw.map(toCourseRef).sort((left, right) => left.code.localeCompare(right.code));
    this.writeCourseCache(refs);
    return refs;
  }

  async resolveCourse(reference: string): Promise<CourseRef> {
    if (/^\d+$/.test(reference)) {
      const id = Number(reference);
      const cached = (await this.courses({ all: true })).find((course) => course.id === id);
      if (cached) return cached;
      return toCourseRef((await this.http.getJson<CanvasCourse>(this.http.canvasUrl(`courses/${id}`))).data);
    }

    const wanted = reference.trim().toUpperCase();
    const courses = await this.courses({ all: true });
    const exact = courses.filter((course) => course.code.toUpperCase() === wanted);
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1) throw ambiguousCourse(reference, exact);
    const prefixed = courses.filter((course) => course.code.toUpperCase().startsWith(wanted));
    if (prefixed.length === 1) return prefixed[0]!;
    if (prefixed.length > 1) throw ambiguousCourse(reference, prefixed);
    throw new CourseReferenceError(`No active course matches ${reference}. Run \`easel courses --all\` to list safe choices.`);
  }

  async assignments(courseId: number): Promise<Assignment[]> {
    return this.http.getPaginated<Assignment>(this.http.canvasUrl(`courses/${courseId}/assignments?${query({ per_page: 100 })}`));
  }

  async submissions(courseId: number): Promise<Submission[]> {
    return this.http.getPaginated<Submission>(
      this.http.canvasUrl(
        `courses/${courseId}/students/submissions?${query({
          "student_ids[]": "self",
          "include[]": ["assignment", "submission_comments", "rubric_assessment"],
          per_page: 100,
        })}`,
      ),
    );
  }

  async assignmentGroups(courseId: number): Promise<AssignmentGroup[]> {
    return this.http.getPaginated<AssignmentGroup>(
      this.http.canvasUrl(`courses/${courseId}/assignment_groups?${query({ "include[]": "assignments", per_page: 100 })}`),
    );
  }

  async modules(courseId: number): Promise<CourseModule[]> {
    return this.http.getPaginated<CourseModule>(
      this.http.canvasUrl(`courses/${courseId}/modules?${query({ "include[]": "items", per_page: 100 })}`),
    );
  }

  async page(courseId: number, slug: string): Promise<CanvasPage> {
    return (await this.http.getJson<CanvasPage>(this.http.canvasUrl(`courses/${courseId}/pages/${encodeURIComponent(slug)}`))).data;
  }

  async announcements(courseIds: number[]): Promise<Announcement[]> {
    if (courseIds.length === 0) return [];
    return this.http.getPaginated<Announcement>(
      this.http.canvasUrl(
        `announcements?${query({ "context_codes[]": courseIds.map((id) => `course_${id}`), per_page: 100 })}`,
      ),
    );
  }

  async discussions(courseId: number): Promise<DiscussionTopic[]> {
    return this.http.getPaginated<DiscussionTopic>(
      this.http.canvasUrl(`courses/${courseId}/discussion_topics?${query({ per_page: 100 })}`),
    );
  }

  async missingSubmissions(): Promise<MissingSubmission[]> {
    try {
      return await this.http.getPaginated<MissingSubmission>(
        this.http.canvasUrl(`users/self/missing_submissions?${query({ per_page: 100 })}`),
      );
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        throw new CanvasFeatureUnavailableError(
          "This Canvas instance does not expose the missing-submissions endpoint. Easel cannot safely infer that nothing is missing.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async due(days: number, courseReference?: string, now = Date.now()): Promise<DueItem[]> {
    const courses = courseReference ? [await this.resolveCourse(courseReference)] : await this.courses();
    const until = now + days * 86_400_000;
    const output: DueItem[] = [];
    for (const course of courses) {
      const [assignments, submissions] = await Promise.all([this.assignments(course.id), this.submissions(course.id)]);
      const byAssignment = new Map(submissions.map((submission) => [submission.assignment_id, submission]));
      for (const assignment of assignments) {
        if (!assignment.due_at) continue;
        const dueAt = new Date(assignment.due_at).getTime();
        if (!Number.isFinite(dueAt) || !withinDueWindow(dueAt, now, until)) continue;
        output.push({ course, assignment, proctored: isProctored(assignment), ...submissionState(byAssignment.get(assignment.id)) });
      }
    }
    return output.sort((left, right) => String(left.assignment.due_at).localeCompare(String(right.assignment.due_at)));
  }

  async marks(courseReference?: string): Promise<{ items: MarkItem[]; projections: WeightedProjection[] }> {
    const courses = courseReference ? [await this.resolveCourse(courseReference)] : await this.courses();
    const items: MarkItem[] = [];
    const projections: WeightedProjection[] = [];
    for (const course of courses) {
      const [submissions, groups] = await Promise.all([this.submissions(course.id), this.assignmentGroups(course.id)]);
      for (const submission of submissions) {
        const assignment = submission.assignment;
        if (!assignment || submission.excused) continue;
        if (submission.score == null && submission.grade == null && !submission.submitted_at) continue;
        items.push({ course, submission, assignment, proctored: isProctored(assignment) });
      }
      projections.push(projectWeighted(course, submissions, groups));
    }
    return { items, projections };
  }

  async findFiles(courseReference?: string): Promise<FoundFile[]> {
    const courses = courseReference ? [await this.resolveCourse(courseReference)] : await this.courses();
    const output: FoundFile[] = [];
    for (const course of courses) {
      for (const assignment of await this.assignments(course.id)) {
        addEmbeddedFiles(output, course, "assignment", assignment.name, assignment.description ?? "", this.config.baseUrl);
      }
      for (const announcement of await this.announcements([course.id])) {
        addEmbeddedFiles(output, course, "announcement", announcement.title, announcement.message ?? "", this.config.baseUrl);
      }
      const pageSlugs = new Set<string>();
      for (const module of await this.modules(course.id)) {
        for (const item of module.items ?? []) {
          if (item.type === "Page" && item.page_url) pageSlugs.add(item.page_url);
          if (item.type === "File" && item.content_id) {
            const url = item.html_url ?? `${this.config.baseUrl}/courses/${course.id}/files/${item.content_id}`;
            const verifier = parseVerifier(url);
            output.push({
              course,
              source: "module",
              title: item.title,
              link: { courseId: course.id, fileId: item.content_id, verifier, url, label: item.title },
            });
          }
        }
      }
      for (const slug of pageSlugs) {
        try {
          const page = await this.page(course.id, slug);
          addEmbeddedFiles(output, course, "page", page.title, page.body ?? "", this.config.baseUrl);
        } catch (error) {
          if (!(error instanceof HttpError && error.status === 404)) throw error;
        }
      }
    }
    return dedupeFiles(output);
  }

  async fileMeta(courseId: number, fileId: number, verifier?: string): Promise<CanvasFileMeta> {
    const suffix = verifier ? `?${query({ verifier })}` : "";
    return (await this.http.getJson<CanvasFileMeta>(this.http.canvasUrl(`courses/${courseId}/files/${fileId}${suffix}`))).data;
  }

  courseCachePath(): string {
    return courseCachePathFor(this.config);
  }

  private readCourseCache(): CourseRef[] | undefined {
    const path = this.courseCachePath();
    try {
      if (!existsSync(path)) return undefined;
      const value = JSON.parse(readFileSync(path, "utf8")) as {
        version?: number;
        namespace?: string;
        at?: number;
        courses?: CourseRef[];
      };
      const namespace = canvasStateNamespace(this.config);
      if (value.version !== 1 || value.namespace !== namespace || !Number.isFinite(value.at)) return undefined;
      if (Date.now() - Number(value.at) > COURSE_CACHE_MS) return undefined;
      return Array.isArray(value.courses) ? value.courses : undefined;
    } catch {
      return undefined;
    }
  }

  private writeCourseCache(courses: CourseRef[]): void {
    try {
      writeJsonFileSync(this.courseCachePath(), {
        version: 1,
        namespace: canvasStateNamespace(this.config),
        at: Date.now(),
        courses,
      });
    } catch {
      return;
    }
  }
}

export function courseCachePathFor(config: Config): string {
  return join(config.cacheDir, "canvas", canvasStateNamespace(config), "courses.json");
}

export function isRealSubject(course: CanvasCourse): boolean {
  return course.workflow_state !== "deleted";
}

export function toCourseRef(course: CanvasCourse): CourseRef {
  return {
    id: course.id,
    code: course.course_code ?? String(course.id),
    name: course.name,
    term: course.term?.name,
    score: course.enrollments?.[0]?.computed_current_score ?? course.enrollments?.[0]?.computed_final_score ?? null,
  };
}

export function isProctored(assignment?: Pick<Assignment, "name">): boolean {
  return /respondus|lockdown/i.test(assignment?.name ?? "");
}

export function withinDueWindow(dueAt: number, now: number, until: number): boolean {
  return dueAt >= now && dueAt <= until;
}

export function submissionState(
  submission?: Submission,
): Pick<DueItem, "submitted" | "submittedAt" | "graded" | "excused" | "missing"> {
  const workflow = submission?.workflow_state?.toLowerCase();
  const submittedAt = submission?.submitted_at ?? null;
  const excused = submission?.excused === true;
  const graded = !excused && (workflow === "graded" || submission?.score != null || submission?.grade != null);
  const submitted = excused || Boolean(submittedAt) || graded || workflow === "submitted" || workflow === "pending_review";
  const missing = !excused && submission?.missing === true && !submitted;
  return { submitted, submittedAt, graded, excused, missing };
}

export function projectWeighted(
  course: CourseRef,
  submissions: Submission[],
  groups: AssignmentGroup[],
): WeightedProjection {
  const byAssignment = new Map(submissions.map((submission) => [submission.assignment_id, submission]));
  const rows: WeightedProjection["groups"] = [];
  const limitations = new Set<string>();
  let weightedContribution = 0;
  let weightedSeen = 0;
  let pointsEarned = 0;
  let pointsPossible = 0;
  let hasDropRules = false;

  for (const group of groups) {
    const weight = finite(group.group_weight);
    const dropRules = hasRules(group);
    hasDropRules ||= dropRules;
    let earned = 0;
    let possible = 0;
    for (const assignment of group.assignments ?? []) {
      const submission = byAssignment.get(assignment.id);
      if (!submission || submission.excused || assignment.omit_from_final_grade || submission.score == null) continue;
      const assignmentPossible = finite(assignment.points_possible);
      earned += submission.score;
      if (assignmentPossible > 0) possible += assignmentPossible;
    }
    const percent = possible > 0 ? (earned / possible) * 100 : undefined;
    if (percent !== undefined && weight > 0) {
      weightedContribution += percent * (weight / 100);
      weightedSeen += weight;
    }
    pointsEarned += earned;
    pointsPossible += possible;
    rows.push({ name: group.name, weight, earned, possible, percent, dropRules });
  }

  if (hasDropRules) limitations.add("Assignment-group drop rules are not reproduced locally.");
  limitations.add("Grading periods, late policies, unpublished adjustments, and manual overrides remain Canvas-controlled.");

  const canvasCurrent = typeof course.score === "number" && Number.isFinite(course.score) ? course.score : undefined;
  let currentGrade: number | undefined;
  let basis: GradeBasis;
  if (canvasCurrent !== undefined) {
    currentGrade = canvasCurrent;
    basis = "canvas";
  } else if (weightedSeen > 0) {
    currentGrade = (weightedContribution / weightedSeen) * 100;
    basis = "simple-weighted";
  } else if (pointsPossible > 0) {
    currentGrade = (pointsEarned / pointsPossible) * 100;
    basis = "points";
  } else {
    basis = "unavailable";
  }

  const finalLockedIn = weightedSeen > 0 && !hasDropRules ? weightedContribution : undefined;
  return { course, currentGrade, finalLockedIn, basis, limitations: [...limitations], groups: rows };
}

function query(values: Record<string, string | number | boolean | Array<string | number | boolean>>): string {
  const output = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) output.append(key, String(item));
  }
  return output.toString();
}

function ambiguousCourse(reference: string, courses: CourseRef[]): CourseReferenceError {
  const choices = courses.slice(0, 10).map((course) => `${course.code} (id ${course.id})`).join(", ");
  const suffix = courses.length > 10 ? `, and ${courses.length - 10} more` : "";
  return new CourseReferenceError(`Course reference ${reference} is ambiguous. Choose one of: ${choices}${suffix}.`);
}

function addEmbeddedFiles(
  output: FoundFile[],
  course: CourseRef,
  source: string,
  title: string,
  html: string,
  baseUrl: string,
): void {
  for (const link of extractCanvasFileLinks(html, baseUrl)) output.push({ course, source, title, link });
}

function parseVerifier(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get("verifier") ?? undefined;
  } catch {
    return undefined;
  }
}

function dedupeFiles(files: FoundFile[]): FoundFile[] {
  const seen = new Set<string>();
  const output: FoundFile[] = [];
  for (const file of files) {
    const key = `${file.link.courseId}:${file.link.fileId}:${file.link.verifier ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ ...file, title: singleLine(file.title) });
  }
  return output;
}

function hasRules(group: AssignmentGroup): boolean {
  return Boolean(
    finite(group.rules?.drop_lowest) > 0 ||
      finite(group.rules?.drop_highest) > 0 ||
      (group.rules?.never_drop?.length ?? 0) > 0,
  );
}

function finite(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export { htmlToText };
