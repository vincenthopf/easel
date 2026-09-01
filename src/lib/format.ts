import chalk from "chalk";

export function dateOnly(value?: string | null): string {
  if (!value) return "no due date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function shortDate(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function daysUntil(value?: string | null): string {
  if (!value) return "";
  const due = new Date(value).getTime();
  if (!Number.isFinite(due)) return "";
  const delta = due - Date.now();
  if (delta < 0) {
    const overdue = Math.max(1, Math.ceil(Math.abs(delta) / 86_400_000));
    return overdue === 1 ? "1d overdue" : `${overdue}d overdue`;
  }
  const days = Math.ceil(delta / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `${days}d`;
}

export function dueStatus(item: {
  dueAt?: string | null;
  submitted: boolean;
  submittedAt?: string | null;
  excused?: boolean;
}): string {
  if (item.excused) return "excused";
  if (!item.submitted) return daysUntil(item.dueAt);
  const due = item.dueAt ? new Date(item.dueAt).getTime() : Number.NaN;
  const submitted = item.submittedAt ? new Date(item.submittedAt).getTime() : Number.NaN;
  if (!Number.isFinite(due) || !Number.isFinite(submitted)) return "submitted ✓";
  return submitted <= due ? "submitted ✓ on-time" : "submitted ✓ late";
}

export function percent(score?: number | null, total?: number | null): string {
  if (score == null || total == null || total <= 0) return "unmarked";
  return `${((score / total) * 100).toFixed(1)}%`;
}

export function points(score?: number | null, total?: number | null): string {
  if (score == null || total == null) return "unmarked";
  return `${fmt(score)}/${fmt(total)}`;
}

export function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.00$/, "").replace(/0$/, "");
}

export function passFail(score?: number | null, total?: number | null): string {
  if (score == null || total == null || total <= 0) return chalk.dim("pending");
  return score / total >= 0.5 ? chalk.green("pass") : chalk.red("below pass");
}

export function bullet(parts: Array<string | undefined | false>): string {
  return parts.filter(Boolean).join(" · ");
}
