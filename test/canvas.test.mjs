// src/data/canvas-source.js: reading a Canvas school (UofT's Quercus).
//
// Canvas is faked at the fetch level with responses shaped like the real API,
// including the "while(1);" a session-authenticated read gets and Link paging.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { CanvasSource, parseCanvasJson, nextPath, shortCode, courseTitle, kindOf, handedInAt } from "../extension/src/data/canvas-source.js";
import { createSource } from "../extension/src/data/source.js";

const BASE = "https://q.utoronto.ca";
const NOW = new Date("2026-10-09T16:00:00Z");
const SETTINGS = { mode: "live", school: "utoronto" };

/** Routes path -> { status, body, link, url }. Bodies get the while(1) prefix Canvas sends. */
function fakeCanvas(routes) {
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const key = u.pathname + u.search;
    seen.push(key);
    const r = routes[key] || routes[u.pathname];
    if (!r) return { ok: false, status: 404, url, headers: { get: () => null }, text: async () => "while(1);{}" };
    const status = r.status || 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      url: r.url || url,
      headers: { get: (h) => (h.toLowerCase() === "link" ? r.link || null : "application/json") },
      text: async () => `while(1);${JSON.stringify(r.body)}`,
    };
  };
  return seen;
}

const source = () => new CanvasSource(SETTINGS, { now: NOW });

describe("helpers", () => {
  test("strips while(1); before parsing", () => {
    assert.deepEqual(parseCanvasJson('while(1);[{"id":1}]'), [{ id: 1 }]);
    assert.deepEqual(parseCanvasJson('{"id":2}'), { id: 2 });
  });

  test("follows rel=next on the same site only", () => {
    const link = `<${BASE}/api/v1/courses?page=1&per_page=100>; rel="current",<${BASE}/api/v1/courses?page=2&per_page=100>; rel="next",<${BASE}/api/v1/courses?page=3&per_page=100>; rel="last"`;
    assert.equal(nextPath(link, BASE), "/api/v1/courses?page=2&per_page=100");
    assert.equal(nextPath(`<https://evil.example/x>; rel="next"`, BASE), null);
    assert.equal(nextPath(null, BASE), null);
  });

  test("UofT course codes and titles", () => {
    assert.equal(shortCode("MAT137Y1 Y LEC0101", "MAT137Y1 Y LEC0101 20269:Calculus with Proofs"), "MAT137Y1");
    assert.equal(shortCode("CSC108H5 F LEC0101"), "CSC108H5");
    assert.equal(shortCode("Hart House Clubs"), "Hart");
    assert.equal(courseTitle("MAT137Y1 Y LEC0101 20269:Calculus with Proofs", "MAT137Y1 Y LEC0101"), "Calculus with Proofs");
    assert.equal(courseTitle("Introduction to Computer Programming", "CSC108H1"), "Introduction to Computer Programming");
  });

  test("kinds", () => {
    assert.equal(kindOf({ submission_types: ["online_upload"] }), "dropbox");
    assert.equal(kindOf({ submission_types: ["online_quiz"], quiz_id: 9 }), "quiz");
    assert.equal(kindOf({ is_quiz_assignment: true, submission_types: ["external_tool"] }), "quiz");
    assert.equal(kindOf({ submission_types: ["discussion_topic"] }), "discussion");
    // No hand-in Canvas can be relied on: ticked off without being checked against Canvas.
    assert.equal(kindOf({ submission_types: ["on_paper"] }), "content");
    assert.equal(kindOf({ submission_types: ["none"] }), "content");
    assert.equal(kindOf({ submission_types: ["external_tool"] }), "content");
    assert.equal(kindOf({ submission_types: ["online_upload", "on_paper"] }), "dropbox");
  });

  test("a grade with no submission isn't handed in", () => {
    assert.equal(handedInAt({ workflow_state: "graded", submitted_at: null, missing: true, score: 0 }), null);
    assert.equal(handedInAt({ workflow_state: "submitted", submitted_at: "2026-10-01T03:00:00Z" }), "2026-10-01T03:00:00.000Z");
    assert.ok(handedInAt({ excused: true, graded_at: "2026-10-02T12:00:00Z" }));
    assert.equal(handedInAt(null), null);
  });
});

describe("a UofT school reads with Canvas", () => {
  test("createSource picks the Canvas reader for UofT", () => {
    assert.ok(createSource(SETTINGS, null, {}) instanceof CanvasSource);
    assert.ok(!(createSource({ mode: "live", school: "uwaterloo" }, null, {}) instanceof CanvasSource));
  });
});

describe("session", () => {
  test("signed in", async () => {
    fakeCanvas({ "/api/v1/users/self": { body: { id: 5, name: "Jane Q Student", short_name: "Jane Student" } } });
    const s = await source().checkSession();
    assert.equal(s.signedIn, true);
    assert.deepEqual(s.student, { name: "Jane Student", initials: "JS" });
  });

  test("401 with no Learn tab to try reads as no-tab", async () => {
    fakeCanvas({ "/api/v1/users/self": { status: 401, body: { status: "unauthenticated" } } });
    const s = await source().checkSession();
    assert.deepEqual(s, { signedIn: false, reason: "no-tab" });
  });

  test("sent off to the school's sign-in page counts as signed out", async () => {
    fakeCanvas({ "/api/v1/users/self": { body: {}, url: "https://idpz.utorauth.utoronto.ca/idp/profile/SAML2/Redirect/SSO" } });
    const tabRelay = async () => ({ status: 200, loginRedirect: true });
    const s = await new CanvasSource(SETTINGS, { now: NOW, relay: tabRelay }).checkSession();
    assert.deepEqual(s, { signedIn: false, reason: "signed-out" });
  });
});

describe("courses", () => {
  const term = { name: "2026 Fall", start_at: "2026-09-01T04:00:00Z", end_at: "2026-12-23T05:00:00Z" };
  const old = { name: "2026 Summer", start_at: "2026-05-01T04:00:00Z", end_at: "2026-08-20T04:00:00Z" };
  const page1 = [
    { id: 101, name: "MAT137Y1 Y LEC0101 20269:Calculus with Proofs", course_code: "MAT137Y1 Y LEC0101", workflow_state: "available", term: { name: "2026-2027 Fall-Winter", start_at: "2026-09-01T04:00:00Z", end_at: "2027-04-30T04:00:00Z" } },
    { id: 102, name: "CSC110Y1 F LEC0201", course_code: "CSC110Y1 F LEC0201", workflow_state: "available", term },
  ];
  const page2 = [
    { id: 103, name: "MAT135H1 S LEC0101 20265", course_code: "MAT135H1 S LEC0101", workflow_state: "available", term: old },
    { id: 104, name: "First-Year Learning Community", course_code: "FLC", workflow_state: "available", term: { name: "Default Term", start_at: null, end_at: null } },
    { id: 105, name: "Unpublished", course_code: "X", workflow_state: "unpublished", term },
  ];

  test("this term's courses, from every page, with the term's own dates", async () => {
    fakeCanvas({
      "/api/v1/courses?enrollment_state=active&include[]=term&per_page=100": { body: page1, link: `<${BASE}/api/v1/courses?enrollment_state=active&include[]=term&per_page=100&page=2>; rel="next"` },
      "/api/v1/courses?enrollment_state=active&include[]=term&per_page=100&page=2": { body: page2 },
    });
    const courses = await source().listCourses();
    const byCode = Object.fromEntries(courses.map((c) => [c.code, c]));
    assert.deepEqual(Object.keys(byCode).sort(), ["CSC110Y1", "FLC", "MAT137Y1"]);
    assert.equal(byCode.MAT137Y1.current, true, "a full-year course runs through today");
    assert.equal(byCode.MAT137Y1.name, "Calculus with Proofs");
    assert.equal(byCode.CSC110Y1.current, true);
    assert.equal(byCode.FLC.current, false, "no dates: kept only with something coming up");
    assert.equal(byCode.MAT137Y1.homeUrl, `${BASE}/courses/101`);
    assert.ok(!courses.some((c) => c.code === "MAT135H1"), "last term's course is left out");
  });
});

describe("deadlines", () => {
  const course = { id: "cv101", orgUnitId: 101, code: "MAT137Y1" };
  const assignments = [
    { id: 1, name: "Problem Set 1", due_at: "2026-10-03T03:59:00Z", html_url: `${BASE}/courses/101/assignments/1`, submission_types: ["online_upload"], published: true, submission: { workflow_state: "submitted", submitted_at: "2026-10-02T22:10:00Z" } },
    { id: 2, name: "Problem Set 2", due_at: "2026-10-17T03:59:00Z", unlock_at: "2026-10-08T04:00:00Z", submission_types: ["online_upload"], published: true, submission: { workflow_state: "unsubmitted", submitted_at: null } },
    { id: 3, name: "Quiz 1", due_at: "2026-10-10T03:59:00Z", submission_types: ["online_quiz"], quiz_id: 77, published: true, submission: { workflow_state: "graded", submitted_at: null, missing: true, score: 0 } },
    { id: 4, name: "Week 3 Discussion", due_at: "2026-10-12T03:59:00Z", submission_types: ["discussion_topic"], published: true, submission: { excused: true, graded_at: "2026-10-05T12:00:00Z" } },
    { id: 5, name: "Lab 2 report", due_at: null, lock_at: "2026-10-20T03:59:00Z", submission_types: ["online_upload"], published: true, submission: null },
    { id: 6, name: "Draft, not out yet", due_at: "2026-10-30T03:59:00Z", published: false },
    { id: 7, name: "Participation", due_at: null, lock_at: null, published: true },
    { id: 8, name: "Old one", due_at: "2026-03-01T03:59:00Z", published: true },
  ];

  test("every dated, published assignment with its own submission", async () => {
    fakeCanvas({ "/api/v1/courses/101/assignments": { body: assignments } });
    const src = source();
    const items = await src.listDeadlines(course);
    const by = Object.fromEntries(items.map((i) => [i.title, i]));
    assert.deepEqual(Object.keys(by).sort(), ["Lab 2 report", "Problem Set 1", "Problem Set 2", "Quiz 1", "Week 3 Discussion"]);

    assert.equal(by["Problem Set 1"].status, "submitted");
    assert.equal(by["Problem Set 1"].completedAt, "2026-10-02T22:10:00.000Z");
    assert.equal(by["Problem Set 1"].id, "101:dropbox:1");
    assert.equal(by["Problem Set 1"].category, "assignment");

    assert.equal(by["Problem Set 2"].status, "open");
    assert.equal(by["Problem Set 2"].opensAt, "2026-10-08T04:00:00.000Z");

    assert.equal(by["Quiz 1"].kind, "quiz");
    assert.equal(by["Quiz 1"].status, "open", "a zero for missing work isn't a submission");

    assert.equal(by["Week 3 Discussion"].kind, "discussion");
    assert.equal(by["Week 3 Discussion"].status, "submitted", "excused counts as done");

    assert.equal(by["Lab 2 report"].category, "lab");
    assert.equal(by["Lab 2 report"].dueField, "end", "no due date: the available-until date");

    assert.deepEqual([...src.readOk.get("cv101")], ["canvas"]);
  });

  test("a course with no dates is kept only with something open coming up", () => {
    const src = source();
    const open = { status: "open", dueAt: "2026-10-20T03:59:00Z" };
    const done = { status: "submitted", dueAt: "2026-10-20T03:59:00Z" };
    assert.equal(src.keepTermless({}, [done]), null);
    assert.deepEqual(src.keepTermless({}, [open, done]), [open, done]);
  });
});

describe("check-off and reminders", () => {
  test("asks Canvas for this one submission", async () => {
    fakeCanvas({ "/api/v1/courses/101/assignments/2/submissions/self": { body: { workflow_state: "submitted", submitted_at: "2026-10-09T15:00:00Z" } } });
    assert.deepEqual(await source().submissionState({ id: "101:dropbox:2" }), { submitted: true, at: "2026-10-09T15:00:00.000Z" });
  });

  test("nothing handed in", async () => {
    fakeCanvas({ "/api/v1/courses/101/assignments/3/submissions/self": { body: { workflow_state: "unsubmitted", submitted_at: null } } });
    assert.deepEqual(await source().submissionState({ id: "101:quiz:3" }), { submitted: false });
  });

  test("can't be asked: null, so no false warning", async () => {
    fakeCanvas({});
    assert.equal(await source().submissionState({ id: "101:dropbox:9" }), null);
  });
});

describe("planner: what isn't an assignment", () => {
  const course = { id: "cv101", orgUnitId: 101, code: "MAT137Y1" };
  const planner = [
    { course_id: 101, plannable_type: "quiz", plannable_id: 31, plannable_date: "2026-10-15T03:59:00Z", html_url: "/courses/101/quizzes/31", plannable: { title: "Practice Quiz 3", assignment_id: null }, submissions: { submitted: false } },
    { course_id: 101, plannable_type: "discussion_topic", plannable_id: 41, plannable_date: "2026-10-16T03:59:00Z", html_url: "/courses/101/discussion_topics/41", plannable: { title: "Introduce yourself", todo_date: "2026-10-16T03:59:00Z" }, submissions: { submitted: true } },
    { course_id: 101, plannable_type: "wiki_page", plannable_id: 51, plannable_date: "2026-10-14T03:59:00Z", html_url: "/courses/101/pages/week-6-reading", plannable: { title: "Week 6 reading" }, submissions: false, planner_override: { marked_complete: true } },
    { course_id: 101, plannable_type: "calendar_event", plannable_id: 61, plannable_date: "2026-10-21T22:00:00Z", html_url: "/calendar?event_id=61", plannable: { title: "Term Test 1", start_at: "2026-10-21T22:00:00Z" }, submissions: false },
    { course_id: 101, plannable_type: "calendar_event", plannable_id: 62, plannable_date: "2026-10-14T18:00:00Z", plannable: { title: "TUT0101 tutorial" }, submissions: false },
    { course_id: 101, plannable_type: "quiz", plannable_id: 71, plannable_date: "2026-10-10T03:59:00Z", plannable: { title: "Quiz 1", assignment_id: 3 } },
    { course_id: 101, plannable_type: "announcement", plannable_id: 81, plannable_date: "2026-10-09T12:00:00Z", plannable: { title: "Welcome" } },
    { course_id: 999, plannable_type: "quiz", plannable_id: 91, plannable_date: "2026-10-15T03:59:00Z", plannable: { title: "Other course quiz" } },
  ];

  test("ungraded quizzes, discussions, to-do pages and deadline-like events are added", async () => {
    fakeCanvas({ "/api/v1/courses/101/assignments": { body: [] }, "/api/v1/planner/items": { body: planner } });
    const src = source();
    const items = await src.listDeadlines(course);
    const by = Object.fromEntries(items.map((i) => [i.title, i]));
    assert.deepEqual(Object.keys(by).sort(), ["Introduce yourself", "Practice Quiz 3", "Term Test 1", "Week 6 reading"]);
    assert.equal(by["Practice Quiz 3"].category, "quiz");
    assert.equal(by["Practice Quiz 3"].status, "open");
    assert.equal(by["Practice Quiz 3"].url, `${BASE}/courses/101/quizzes/31`);
    assert.equal(by["Introduce yourself"].status, "submitted");
    assert.equal(by["Week 6 reading"].status, "done", "ticked off in Quercus");
    assert.equal(by["Term Test 1"].category, "quiz");
    for (const i of items) assert.equal(i.kind, "content", "never checked against Canvas on check-off");
    assert.deepEqual([...src.readOk.get("cv101")].sort(), ["canvas", "canvas-planner"]);
  });

  test("the planner is read once for every course", async () => {
    const seen = fakeCanvas({ "/api/v1/courses/101/assignments": { body: [] }, "/api/v1/courses/102/assignments": { body: [] }, "/api/v1/planner/items": { body: planner } });
    const src = source();
    await src.listDeadlines(course);
    await src.listDeadlines({ id: "cv102", orgUnitId: 102, code: "CSC110Y1" });
    assert.equal(seen.filter((p) => p.startsWith("/api/v1/planner/items")).length, 1);
  });

  test("a planner that fails leaves the assignments, and the planner's old items aren't dropped", async () => {
    fakeCanvas({ "/api/v1/courses/101/assignments": { body: [{ id: 1, name: "PS1", due_at: "2026-10-20T03:59:00Z", submission_types: ["online_upload"], published: true }] } });
    const src = source();
    const items = await src.listDeadlines(course);
    assert.deepEqual(items.map((i) => i.title), ["PS1"]);
    assert.deepEqual([...src.readOk.get("cv101")], ["canvas"], "planner items from before stay");
  });
});
