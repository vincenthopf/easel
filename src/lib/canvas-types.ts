export interface CanvasProfile {
  id: number;
  name: string;
  short_name?: string;
  primary_email?: string;
  login_id?: string;
}

export interface CanvasCourse {
  id: number;
  name: string;
  course_code?: string;
  workflow_state?: string;
  term?: { name?: string };
  enrollments?: Array<{ computed_current_score?: number | null; computed_final_score?: number | null }>;
}

export interface Assignment {
  id: number;
  name: string;
  due_at?: string | null;
  unlock_at?: string | null;
  points_possible?: number | null;
  quiz_id?: number | null;
  description?: string | null;
  submission_types?: string[];
  assignment_group_id?: number;
}

export interface Submission {
  id: number;
  assignment_id: number;
  score?: number | null;
  grade?: string | null;
  submitted_at?: string | null;
  workflow_state?: string;
  late?: boolean;
  missing?: boolean;
  assignment?: Assignment;
  submission_comments?: Array<{ comment?: string; author_name?: string }>;
  rubric_assessment?: unknown;
}

export interface AssignmentGroup {
  id: number;
  name: string;
  group_weight?: number;
  assignments?: Assignment[];
}

export interface ModuleItem {
  id: number;
  title: string;
  type: string;
  page_url?: string;
  html_url?: string;
  url?: string;
  indent?: number;
}

export interface CourseModule {
  id: number;
  name: string;
  position?: number;
  items?: ModuleItem[];
}

export interface CanvasPage {
  page_id: number;
  title: string;
  url: string;
  body?: string;
  html_url?: string;
}

export interface Announcement {
  id: number;
  title: string;
  message?: string;
  posted_at?: string;
  delayed_post_at?: string;
  html_url?: string;
  context_code?: string;
}

export interface DiscussionTopic {
  id: number;
  title: string;
  message?: string;
  posted_at?: string;
  last_reply_at?: string;
  discussion_subentry_count?: number;
  html_url?: string;
  locked?: boolean;
}

export interface MissingSubmission {
  id: number;
  name: string;
  course_id: number;
  due_at?: string | null;
  points_possible?: number | null;
  html_url?: string;
}

export interface CanvasFileMeta {
  id: number;
  display_name: string;
  filename?: string;
  "content-type"?: string;
  content_type?: string;
  size?: number;
  url: string;
}
