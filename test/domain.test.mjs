import assert from "node:assert/strict";
import test from "node:test";

import {
  CanvasClient,
  CanvasFeatureUnavailableError,
  CourseReferenceError,
  courseCachePathFor,
  projectWeighted,
  submissionState,
  withinDueWindow,
} from "../dist/lib/canvas.js";
import { HttpError } from "../dist/lib/http.js";
import { configFixture, workspace } from "./helpers.mjs";

test("course resolution prefers exact codes and rejects ambiguous prefixes", async () => {
  const place = await workspace();
  try {
    const client = new CanvasClient(configFixture("http://localhost:3000", { cacheDir: place.cache }));
    client.courses = async () => [
      { id: 1, code: "BIO101", name: "Biology" },
      { id: 2, code: "BIO102", name: "Advanced Biology" },
      { id: 3, code: "CHEM101", name: "Chemistry" },
    ];
    assert.equal((await client.resolveCourse("bio101")).id, 1);
    assert.equal((await client.resolveCourse("CHEM")).id, 3);
    await assert.rejects(client.resolveCourse("BIO"), CourseReferenceError);
  } finally {
    await place.cleanup();
  }
});

test("course cache paths are scoped to Canvas origin and credential identity", async () => {
  const place = await workspace();
  try {
    const first = configFixture("https://one.example", { cacheDir: place.cache, token: "one" });
    const second = configFixture("https://two.example", { cacheDir: place.cache, token: "one" });
    const third = configFixture("https://one.example", { cacheDir: place.cache, token: "two" });
    assert.notEqual(courseCachePathFor(first), courseCachePathFor(second));
    assert.notEqual(courseCachePathFor(first), courseCachePathFor(third));
    assert.doesNotMatch(courseCachePathFor(first), /one$/);
  } finally {
    await place.cleanup();
  }
});

test("missing-submission authentication and permission failures are not empty academic data", async () => {
  const place = await workspace();
  try {
    const client = new CanvasClient(configFixture("http://localhost:3000", { cacheDir: place.cache }));
    client.http.getPaginated = async () => { throw new HttpError(401, "http://localhost/profile", "unauthorized"); };
    await assert.rejects(client.missingSubmissions(), (error) => error instanceof HttpError && error.status === 401);
    client.http.getPaginated = async () => { throw new HttpError(403, "http://localhost/profile", "forbidden"); };
    await assert.rejects(client.missingSubmissions(), (error) => error instanceof HttpError && error.status === 403);
    client.http.getPaginated = async () => { throw new HttpError(404, "http://localhost/missing", "not found"); };
    await assert.rejects(client.missingSubmissions(), CanvasFeatureUnavailableError);
  } finally {
    await place.cleanup();
  }
});

test("due windows exclude overdue work and include exact boundaries", () => {
  const now = Date.UTC(2026, 8, 1, 0, 0, 0);
  const until = now + 7 * 86_400_000;
  assert.equal(withinDueWindow(now - 1, now, until), false);
  assert.equal(withinDueWindow(now, now, until), true);
  assert.equal(withinDueWindow(until, now, until), true);
  assert.equal(withinDueWindow(until + 1, now, until), false);
});

test("submission state distinguishes excused, submitted, graded, and missing work", () => {
  assert.deepEqual(submissionState(undefined), { submitted: false, submittedAt: null, graded: false, excused: false, missing: false });
  assert.equal(submissionState({ id: 1, assignment_id: 1, excused: true }).submitted, true);
  assert.equal(submissionState({ id: 1, assignment_id: 1, workflow_state: "submitted", submitted_at: "2026-01-01" }).submitted, true);
  assert.equal(submissionState({ id: 1, assignment_id: 1, workflow_state: "graded", score: 0 }).graded, true);
  assert.equal(submissionState({ id: 1, assignment_id: 1, missing: true }).missing, true);
});

test("a null Canvas score is unavailable rather than zero", () => {
  const projection = projectWeighted(
    { id: 1, code: "BIO101", name: "Biology", score: null },
    [],
    [],
  );
  assert.equal(projection.currentGrade, undefined);
  assert.equal(projection.basis, "unavailable");
});

test("grade projection prefers Canvas score and does not overstate drop-rule results", () => {
  const projection = projectWeighted(
    { id: 1, code: "BIO101", name: "Biology", score: 82.5 },
    [
      { id: 1, assignment_id: 10, score: 8 },
      { id: 2, assignment_id: 11, score: 2, excused: true },
    ],
    [
      {
        id: 100,
        name: "Assignments",
        group_weight: 40,
        rules: { drop_lowest: 1 },
        assignments: [
          { id: 10, name: "One", points_possible: 10 },
          { id: 11, name: "Two", points_possible: 10 },
        ],
      },
    ],
  );
  assert.equal(projection.currentGrade, 82.5);
  assert.equal(projection.basis, "canvas");
  assert.equal(projection.finalLockedIn, undefined);
  assert.ok(projection.limitations.some((value) => /drop rules/.test(value)));
});

test("unweighted projection uses points and supports zero-point extra credit without denominator inflation", () => {
  const projection = projectWeighted(
    { id: 1, code: "BIO101", name: "Biology" },
    [
      { id: 1, assignment_id: 10, score: 8 },
      { id: 2, assignment_id: 11, score: 2 },
    ],
    [
      {
        id: 100,
        name: "Points",
        group_weight: 0,
        assignments: [
          { id: 10, name: "One", points_possible: 10 },
          { id: 11, name: "Bonus", points_possible: 0 },
        ],
      },
    ],
  );
  assert.equal(projection.basis, "points");
  assert.equal(projection.currentGrade, 100);
});

test("module File items are included without regex-only discovery", async () => {
  const place = await workspace();
  try {
    const client = new CanvasClient(configFixture("http://localhost:3000", { cacheDir: place.cache }));
    client.courses = async () => [{ id: 1, code: "BIO101", name: "Biology" }];
    client.assignments = async () => [];
    client.announcements = async () => [];
    client.modules = async () => [{ id: 1, name: "Week 1", items: [{ id: 4, title: "Brief", type: "File", content_id: 99, html_url: "http://localhost:3000/courses/1/files/99" }] }];
    const files = await client.findFiles("BIO101");
    assert.equal(files.length, 1);
    assert.equal(files[0].link.fileId, 99);
    assert.equal(files[0].source, "module");
  } finally {
    await place.cleanup();
  }
});

test("file metadata carries the parsed verifier into the authenticated endpoint", async () => {
  const place = await workspace();
  try {
    const client = new CanvasClient(configFixture("http://localhost:3000", { cacheDir: place.cache }));
    let requested;
    client.http.getJson = async (url) => {
      requested = url;
      return { data: { id: 9, display_name: "file.pdf", url: "https://files.example/signed" }, headers: new Headers(), url };
    };
    await client.fileMeta(1, 9, "verifier-value");
    assert.match(requested, /verifier=verifier-value/);
  } finally {
    await place.cleanup();
  }
});

test("course discovery does not hide institution-specific code formats", async () => {
  const place = await workspace();
  try {
    const client = new CanvasClient(configFixture("http://localhost:3000", { cacheDir: place.cache }));
    client.http.getPaginated = async () => [
      { id: 1, name: "History", course_code: "HIST-INTRO", workflow_state: "available" },
      { id: 2, name: "Studio", course_code: "ART_2A", workflow_state: "available" },
    ];
    const courses = await client.courses({ cached: false });
    assert.deepEqual(courses.map((course) => course.code), ["ART_2A", "HIST-INTRO"]);
  } finally {
    await place.cleanup();
  }
});

test("file discovery propagates page authorization failures", async () => {
  const place = await workspace();
  try {
    const client = new CanvasClient(configFixture("http://localhost:3000", { cacheDir: place.cache }));
    client.courses = async () => [{ id: 1, code: "BIO101", name: "Biology" }];
    client.assignments = async () => [];
    client.announcements = async () => [];
    client.modules = async () => [{ id: 1, name: "Week 1", items: [{ id: 2, title: "Page", type: "Page", page_url: "week-1" }] }];
    client.page = async () => { throw new HttpError(403, "http://localhost/page", "forbidden"); };
    await assert.rejects(client.findFiles("BIO101"), (error) => error instanceof HttpError && error.status === 403);
  } finally {
    await place.cleanup();
  }
});
