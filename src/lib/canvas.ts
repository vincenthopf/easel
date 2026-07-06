import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Config } from "./config.js";
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
import { extractCanvasFileLinks, htmlToText, singleLine } from "./html.js";
import type { FileLink } from "./html.js";
import { HttpError, ReadOnlyHttpClient } from "./http.js";

// Non-academic shells (orientation, integrity modules, etc.) are hidden by the
// course-code pattern below — real subjects look like ABC123. No institution-
// specific course ids are baked in here.
const ADMIN_SHELL_IDS = new Set<number>();
const REAL_SUBJECT_RE = /^[A-Z]{2,4}\d{3}/;
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
}

export interface MarkItem {
  course: CourseRef;
  submission: Submission;
  assignment?: Assignment;
  proctored: boolean;
}

export interface WeightedProjection {
  course: CourseRef;
  currentGrade?: number;
  finalLockedIn?: number;
  groups: Array<{ name: string; weight: number; earned?: number; possible?: number; percent?: number }>;
}

export interface FoundFile {
  course: CourseRef;
  source: string;
  title: string;
  link: FileLink;
}

function qs(params: Record<string, string | number | boolean | Array<string | number | boolean>>): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) out.append(key, String(item));
  }
  return out.toString();
}

export function isRealSubject(course: CanvasCourse): boolean {
  const code = course.course_code ?? "";
  return !ADMIN_SHELL_IDS.has(course.id) && REAL_SUBJECT_RE.test(code);
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

export class CanvasClient {
  readonly http: ReadOnlyHttpClient;

  constructor(readonly config: Config) {
    this.http = new ReadOnlyHttpClient(config);
  }

  async profile(): Promise<CanvasProfile> {
    return (await this.http.getJson<CanvasProfile>(this.http.canvasUrl("/users/self/profile"))).data;
  }

  async courses(options: { all?: boolean; cached?: boolean } = {}): Promise<CourseRef[]> {
    const cached = options.cached ?? true;
    if (cached) {
      const hit = this.readCourseCache();
      if (hit) return options.all ? hit : hit.filter((course) => isRealRef(course));
    }

    const path = `/courses?${qs({
      enrollment_state: "active",
      "include[]": ["term", "total_scores"],
      per_page: 100,
    })}`;
    const raw = await this.http.getPaginated<CanvasCourse>(this.http.canvasUrl(path));
    const refs = raw.map(toCourseRef).sort((a, b) => a.code.localeCompare(b.code));
    this.writeCourseCache(refs);
    return options.all ? refs : refs.filter((course) => isRealRef(course));
  }

  async resolveCourse(ref: string): Promise<CourseRef> {
    if (/^\d+$/.test(ref)) {
      const id = Number(ref);
      const found = (await this.courses({ all: true })).find((course) => course.id === id);
      if (found) return found;
      const raw = (await this.http.getJson<CanvasCourse>(this.http.canvasUrl(`/courses/${id}`))).data;
      return toCourseRef(raw);
    }

    const wanted = ref.toUpperCase();
    const found = (await this.courses({ all: true })).find(
      (course) => course.code.toUpperCase() === wanted || course.code.toUpperCase().startsWith(wanted),
    );
    if (!found) throw new Error(`No active course matches ${ref}`);
    return found;
  }

  async assignments(courseId: number): Promise<Assignment[]> {
    return this.http.getPaginated<Assignment>(
      this.http.canvasUrl(`/courses/${courseId}/assignments?${qs({ per_page: 100 })}`),
    );
  }

  async submissions(courseId: number): Promise<Submission[]> {
    return this.http.getPaginated<Submission>(
      this.http.canvasUrl(
        `/courses/${courseId}/students/submissions?${qs({
          "student_ids[]": "self",
          "include[]": ["assignment", "submission_comments", "rubric_assessment"],
          per_page: 100,
        })}`,
      ),
    );
  }

  async assignmentGroups(courseId: number): Promise<AssignmentGroup[]> {
    return this.http.getPaginated<AssignmentGroup>(
      this.http.canvasUrl(`/courses/${courseId}/assignment_groups?${qs({ "include[]": "assignments", per_page: 100 })}`),
    );
  }

  async modules(courseId: number): Promise<CourseModule[]> {
    return this.http.getPaginated<CourseModule>(
      this.http.canvasUrl(`/courses/${courseId}/modules?${qs({ "include[]": "items", per_page: 100 })}`),
    );
  }

  async page(courseId: number, slug: string): Promise<CanvasPage> {
    const encoded = encodeURIComponent(slug);
    return (await this.http.getJson<CanvasPage>(this.http.canvasUrl(`/courses/${courseId}/pages/${encoded}`))).data;
  }

  async announcements(courseIds: number[]): Promise<Announcement[]> {
    if (courseIds.length === 0) return [];
    const context = courseIds.map((id) => `course_${id}`);
    return this.http.getPaginated<Announcement>(
      this.http.canvasUrl(`/announcements?${qs({ "context_codes[]": context, per_page: 100 })}`),
    );
  }

  async discussions(courseId: number): Promise<DiscussionTopic[]> {
    return this.http.getPaginated<DiscussionTopic>(
      this.http.canvasUrl(`/courses/${courseId}/discussion_topics?${qs({ per_page: 100 })}`),
    );
  }

  async missingSubmissions(): Promise<MissingSubmission[]> {
    try {
      return await this.http.getPaginated<MissingSubmission>(
        this.http.canvasUrl(`/users/self/missing_submissions?${qs({ per_page: 100 })}`),
      );
    } catch (error) {
      if (error instanceof HttpError && [401, 403, 404].includes(error.status)) return [];
      throw error;
    }
  }

  async due(days: number, courseRef?: string): Promise<DueItem[]> {
    const courses = courseRef ? [await this.resolveCourse(courseRef)] : await this.courses();
    const now = Date.now();
    const until = now + days * 86_400_000;
    const out: DueItem[] = [];

    for (const course of courses) {
      const [assignments, submissions] = await Promise.all([this.assignments(course.id), this.submissions(course.id)]);
      const byAssignment = new Map(submissions.map((submission) => [submission.assignment_id, submission]));
      for (const assignment of assignments) {
        if (!assignment.due_at) continue;
        const due = new Date(assignment.due_at).getTime();
        if (!Number.isFinite(due)) continue;
        if (due >= now - 86_400_000 && due <= until) {
          out.push({
            course,
            assignment,
            proctored: isProctored(assignment),
            ...submissionState(byAssignment.get(assignment.id)),
          });
        }
      }
    }

    return out.sort((a, b) => String(a.assignment.due_at).localeCompare(String(b.assignment.due_at)));
  }

  async marks(courseRef?: string): Promise<{ items: MarkItem[]; projections: WeightedProjection[] }> {
    const courses = courseRef ? [await this.resolveCourse(courseRef)] : await this.courses();
    const items: MarkItem[] = [];
    const projections: WeightedProjection[] = [];

    for (const course of courses) {
      const [submissions, groups] = await Promise.all([this.submissions(course.id), this.assignmentGroups(course.id)]);
      for (const submission of submissions) {
        const assignment = submission.assignment;
        if (!assignment) continue;
        if (submission.score == null && submission.grade == null && !submission.submitted_at) continue;
        items.push({ course, submission, assignment, proctored: isProctored(assignment) });
      }
      projections.push(projectWeighted(course, submissions, groups));
    }

    return { items, projections };
  }

  async findFiles(courseRef?: string): Promise<FoundFile[]> {
    const courses = courseRef ? [await this.resolveCourse(courseRef)] : await this.courses();
    const out: FoundFile[] = [];

    for (const course of courses) {
      const assignments = await this.assignments(course.id);
      for (const assignment of assignments) {
        for (const link of extractCanvasFileLinks(assignment.description ?? "", this.config.baseUrl)) {
          out.push({ course, source: "assignment", title: assignment.name, link });
        }
      }

      const announcements = await this.announcements([course.id]);
      for (const announcement of announcements) {
        for (const link of extractCanvasFileLinks(announcement.message ?? "", this.config.baseUrl)) {
          out.push({ course, source: "announcement", title: announcement.title, link });
        }
      }

      const modules = await this.modules(course.id);
      const pageSlugs = new Set<string>();
      for (const module of modules) {
        for (const item of module.items ?? []) {
          if (item.type === "Page" && item.page_url) pageSlugs.add(item.page_url);
        }
      }
      for (const slug of pageSlugs) {
        try {
          const page = await this.page(course.id, slug);
          for (const link of extractCanvasFileLinks(page.body ?? "", this.config.baseUrl)) {
            out.push({ course, source: "page", title: page.title, link });
          }
        } catch (error) {
          if (!(error instanceof HttpError && [401, 403, 404].includes(error.status))) throw error;
        }
      }
    }

    return dedupeFiles(out);
  }

  async fileMeta(courseId: number, fileId: number): Promise<CanvasFileMeta> {
    return (await this.http.getJson<CanvasFileMeta>(this.http.canvasUrl(`/courses/${courseId}/files/${fileId}`))).data;
  }

  private courseCachePath(): string {
    return join(this.config.cacheDir, "courses.json");
  }

  private readCourseCache(): CourseRef[] | undefined {
    const path = this.courseCachePath();
    try {
      if (!existsSync(path)) return undefined;
      const raw = JSON.parse(readFileSync(path, "utf8")) as { at: number; courses: CourseRef[] };
      if (Date.now() - raw.at > COURSE_CACHE_MS) return undefined;
      return Array.isArray(raw.courses) ? raw.courses : undefined;
    } catch {
      return undefined;
    }
  }

  private writeCourseCache(courses: CourseRef[]): void {
    try {
      writeFileSync(this.courseCachePath(), `${JSON.stringify({ at: Date.now(), courses }, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // Cache is an optimisation only.
    }
  }
}

function isRealRef(course: CourseRef): boolean {
  return !ADMIN_SHELL_IDS.has(course.id) && REAL_SUBJECT_RE.test(course.code);
}

function submissionState(submission?: Submission): Pick<DueItem, "submitted" | "submittedAt" | "graded"> {
  const workflow = submission?.workflow_state?.toLowerCase();
  const submittedAt = submission?.submitted_at ?? null;
  const graded = workflow === "graded" || submission?.score != null || submission?.grade != null;
  const submitted = Boolean(submittedAt) || graded || workflow === "submitted" || workflow === "pending_review";

  return { submitted, submittedAt, graded };
}

function projectWeighted(course: CourseRef, submissions: Submission[], groups: AssignmentGroup[]): WeightedProjection {
  const byAssignment = new Map(submissions.map((submission) => [submission.assignment_id, submission]));
  const rows: WeightedProjection["groups"] = [];
  let finalLockedIn = 0;
  let weightSeen = 0;

  for (const group of groups) {
    const weight = Number(group.group_weight ?? 0);
    let earned = 0;
    let possible = 0;

    for (const assignment of group.assignments ?? []) {
      const submission = byAssignment.get(assignment.id);
      if (submission?.score == null || assignment.points_possible == null || assignment.points_possible <= 0) continue;
      earned += submission.score;
      possible += assignment.points_possible;
    }

    const pct = possible > 0 ? (earned / possible) * 100 : undefined;
    if (pct !== undefined && weight > 0) {
      finalLockedIn += pct * (weight / 100);
      weightSeen += weight;
    }
    rows.push({ name: group.name, weight, earned, possible, percent: pct });
  }

  return {
    course,
    currentGrade: weightSeen > 0 ? (finalLockedIn / weightSeen) * 100 : undefined,
    finalLockedIn: weightSeen > 0 ? finalLockedIn : undefined,
    groups: rows,
  };
}

function dedupeFiles(files: FoundFile[]): FoundFile[] {
  const seen = new Set<string>();
  const out: FoundFile[] = [];
  for (const file of files) {
    const key = `${file.link.courseId}:${file.link.fileId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...file,
      title: singleLine(file.title),
    });
  }
  return out;
}

export { htmlToText };
