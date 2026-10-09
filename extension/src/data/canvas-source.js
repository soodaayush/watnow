/*
  LIVE mode for a school on Instructure Canvas (UofT's Quercus).

  Implements the same DeadlineSource as live-source.js does for Brightspace, so
  the panel, reminders, badge and calendar file need nothing new. Canvas has a
  documented student API that reports each student's own submission, so unlike
  Brightspace no page is ever read: every request is a GET under /api/v1/.

  Session
    GET /api/v1/users/self
      { id, name, short_name, sortable_name }. 401 means nobody is signed in.
      Reading with the browser's session (not a token) makes Canvas put
      "while(1);" in front of every JSON body, so it is stripped before parsing.

  Courses
    GET /api/v1/courses?enrollment_state=active&include[]=term&per_page=100
      [{ id, name, course_code, workflow_state, start_at, end_at,
         term: { name, start_at, end_at } }]
      The term's own dates decide which courses are this term's: a course whose
      term (or, without one, the course itself) runs through today, give or take
      two weeks, is current. One with no dates at all ("Default Term", a club
      or community course) is read too and kept only with something coming up,
      the same as a Brightspace unit with no term.

  Deadlines
    GET /api/v1/courses/{id}/assignments?include[]=submission&per_page=100
      [{ id, name, due_at, unlock_at, lock_at, html_url, submission_types,
         is_quiz_assignment, quiz_id, published,
         submission: { submitted_at, workflow_state, excused, missing } }]
      Quizzes and graded discussions are assignments too. submitted_at set (or
      excused) means handed in; a "graded" with no submitted_at is a mark given
      without a submission (a zero for missing work) and does not count.
      due_at, then lock_at (available until), is the date. Nothing dated is skipped.

  One item's submission, for check-off and reminders
    GET /api/v1/courses/{id}/assignments/{id}/submissions/self

  Paging follows the Link header's rel="next", which Canvas gives as a full URL.
  Items are keyed `${courseId}:${kind}:${assignmentId}`, like Brightspace ones.
*/

import { liveBase, assignColors, REQUEST_TIMEOUT_MS } from "./live-source.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const GAP_MS = 150;
const MAX_PAGES = 25;
// The read stays inside this window around today, like the Brightspace read.
const KEEP_BEFORE_MS = 120 * DAY_MS;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function isoOrNull(v) {
  if (!v || typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Canvas's JSON, without the "while(1);" a session-authenticated read gets. */
export function parseCanvasJson(text) {
  return JSON.parse(String(text).replace(/^\s*while\s*\(1\)\s*;/, ""));
}

/** The rel="next" URL from a Link header, as a path on the same site, or null. */
export function nextPath(link, base) {
  const m = String(link || "").match(/<([^>]+)>\s*;\s*rel="next"/);
  if (!m) return null;
  try {
    const u = new URL(m[1], base);
    if (u.origin !== new URL(base).origin) return null;
    return u.pathname + u.search;
  } catch {
    return null;
  }
}

/**
 * "MAT137Y1 Y LEC0101" -> "MAT137Y1"; "CSC108H5 F LEC0101" -> "CSC108H5".
 * Anything that doesn't look like a UofT code keeps its first word.
 */
export function shortCode(courseCode, name) {
  const s = String(courseCode || name || "").trim();
  const uoft = s.match(/\b([A-Z]{3}\d{3}[HY]\d)\b/);
  if (uoft) return uoft[1];
  return s.split(/\s+/)[0].slice(0, 16) || "Course";
}

/** The course's title without the code and section in front of it. */
export function courseTitle(name, code) {
  let s = String(name || "").trim();
  if (code && s.startsWith(code)) s = s.slice(code.length);
  // UofT names often carry the section and session: "MAT137Y1 Y LEC0101 20269: Calculus".
  s = s.replace(/^[\s:–-]*(?:[A-Z]\s+)?(?:(?:LEC|TUT|PRA)\d{4}\s*)*(?:\d{5}\s*)?[:–-]?\s*/, "");
  return s || String(name || "").trim();
}

/** dropbox / quiz / discussion, the same kinds the rest of WATnow knows. */
export function kindOf(a) {
  const types = Array.isArray(a.submission_types) ? a.submission_types : [];
  if (a.is_quiz_assignment || a.quiz_id != null || types.includes("online_quiz")) return "quiz";
  if (types.includes("discussion_topic") || a.discussion_topic) return "discussion";
  return "dropbox";
}

function categoryFor(kind, title) {
  if (kind === "quiz" || kind === "discussion") return kind;
  return /^\s*lab\b/i.test(title || "") ? "lab" : "assignment";
}

/** When it was handed in, or null. A grade with no submission doesn't count. */
export function handedInAt(sub) {
  if (!sub) return null;
  if (sub.submitted_at) return isoOrNull(sub.submitted_at);
  if (sub.excused === true) return isoOrNull(sub.graded_at) || new Date().toISOString();
  return null;
}

export class CanvasSource {
  constructor(settings, opts = {}) {
    this.mode = "live";
    this.platform = "canvas";
    this.base = liveBase(settings);
    this.settings = settings;
    this.relay = opts.relay || null;
    this.now = opts.now || new Date();
    this.via = "worker";
    this.lastAt = 0;
    // Course id -> the sources that read completely for it this time. Canvas
    // items all come from one place, so that is "canvas".
    this.readOk = new Map();
    this.report = {
      kind: "watnow-live-debug",
      platform: "canvas",
      startedAt: this.now.toISOString(),
      base: this.base,
      requests: [],
      notes: [],
      courses: [],
    };
  }

  /** One GET through the worker or an open tab. Resolves to { status, json, link, signedOut }. */
  async fetchVia(path, via) {
    const gap = GAP_MS - (Date.now() - this.lastAt);
    if (gap > 0) await wait(gap);
    this.lastAt = Date.now();
    if (via === "tab") {
      if (!this.relay) return { noTab: true };
      try {
        const r = await this.relay(this.base, path);
        if (!r || r.noTab) return { noTab: true };
        return { status: r.status, json: r.json, link: r.link || null, signedOut: !!r.loginRedirect, error: r.error, parseError: r.parseError };
      } catch (e) {
        return { status: 0, error: String(e && e.message ? e.message : e) };
      }
    }
    let res;
    try {
      res = await fetch(this.base + path, { credentials: "include", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      return { status: 0, error: e && e.name === "TimeoutError" ? "timeout" : String(e && e.message ? e.message : e) };
    }
    const out = { status: res.status, link: res.headers.get("link") };
    // A redirect off the site is the school's sign-in page.
    if (res.url && new URL(res.url).origin !== new URL(this.base).origin) out.signedOut = true;
    if (res.ok) {
      try {
        out.json = parseCanvasJson(await res.text());
      } catch (e) {
        out.parseError = String(e && e.message ? e.message : e);
      }
    }
    return out;
  }

  /** One GET. Returns { json, link } or throws an Error with code signed-out, forbidden, not-found, not-json, http, network or no-tab. */
  async api(path, { via = this.via } = {}) {
    const t0 = Date.now();
    const r = await this.fetchVia(path, via);
    const entry = { endpoint: path.split("?")[0].replace(/\/\d+(?=\/|$)/g, "/{id}"), via, status: r.status ?? null, ms: Date.now() - t0 };
    this.report.requests.push(entry);
    let code = null;
    if (r.noTab) code = "no-tab";
    else if (r.signedOut || r.status === 401) code = "signed-out";
    else if (r.status === 0) code = "network";
    else if (r.status === 403) code = "forbidden";
    else if (r.status === 404) code = "not-found";
    else if (r.status < 200 || r.status >= 300) code = "http";
    else if (r.json === undefined) code = "not-json";
    if (code) {
      entry.error = code;
      const err = new Error(code === "signed-out" ? "Canvas says nobody is signed in." : `Canvas returned ${r.status || "no response"} for ${entry.endpoint}`);
      err.code = code;
      err.status = r.status;
      throw err;
    }
    if (Array.isArray(r.json)) entry.count = r.json.length;
    return { json: r.json, link: r.link };
  }

  /** Every page of a list, following Link rel="next". */
  async paged(path, via = this.via) {
    const out = [];
    let next = path;
    for (let i = 0; i < MAX_PAGES && next; i++) {
      const { json, link } = await this.api(next, { via });
      if (Array.isArray(json)) out.push(...json);
      next = nextPath(link, this.base);
    }
    return out;
  }

  async whoami(via) {
    try {
      const { json: me } = await this.api("/api/v1/users/self", { via });
      if (!me || typeof me !== "object" || me.id == null) return { signedIn: false, why: "odd-whoami" };
      const name = String(me.short_name || me.name || "").trim();
      const parts = String(me.name || name).trim().split(/\s+/);
      const initials = `${(parts[0] || "").charAt(0)}${(parts.length > 1 ? parts[parts.length - 1] : "").charAt(0)}`.toUpperCase();
      return { signedIn: true, student: { name, initials } };
    } catch (e) {
      return { signedIn: false, why: e.code || "error" };
    }
  }

  async checkSession() {
    const worker = await this.whoami("worker");
    const session = { worker: worker.signedIn ? "signed-in" : worker.why };
    this.report.session = session;
    if (worker.signedIn) {
      this.via = "worker";
      return { signedIn: true, student: worker.student, via: "worker" };
    }
    let tab = { why: "no-tab" };
    if (this.relay) {
      tab = await this.whoami("tab");
      session.tab = tab.signedIn ? "signed-in" : tab.why;
      if (tab.signedIn) {
        this.via = "tab";
        return { signedIn: true, student: tab.student, via: "tab" };
      }
    }
    const out = new Set(["signed-out", "forbidden", "not-json", "odd-whoami"]);
    let reason = "unreachable";
    if (out.has(tab.why)) reason = "signed-out";
    else if (tab.why === "no-tab" && out.has(worker.why)) reason = "no-tab";
    return { signedIn: false, reason };
  }

  /**
   * Whether a course belongs to now: its term's dates (or the course's own,
   * without a term) run through today, two weeks either side. null when
   * Canvas gives no dates at all.
   */
  isCurrent(c) {
    const term = c.term || {};
    const start = Date.parse(term.start_at || c.start_at || "");
    const end = Date.parse(term.end_at || c.end_at || "");
    if (Number.isNaN(start) && Number.isNaN(end)) return null;
    const now = this.now.getTime();
    return (Number.isNaN(start) || start - 14 * DAY_MS <= now) && (Number.isNaN(end) || end + 14 * DAY_MS >= now);
  }

  async listCourses() {
    const rows = await this.paged("/api/v1/courses?enrollment_state=active&include[]=term&per_page=100");
    const courses = [];
    let otherTerm = 0;
    for (const c of rows) {
      if (!c || c.id == null || c.access_restricted_by_date) continue;
      if (c.workflow_state && c.workflow_state !== "available") continue;
      const current = this.isCurrent(c);
      if (current === false) {
        otherTerm++;
        continue;
      }
      const code = shortCode(c.course_code, c.name);
      courses.push({
        id: `cv${c.id}`,
        code,
        name: courseTitle(c.name, c.course_code),
        orgUnitId: Number(c.id),
        color: "mint",
        termMatch: current === true,
        current: current === true,
        homeUrl: `${this.base}/courses/${c.id}`,
      });
    }
    // Nothing dated as this term: show every active course rather than none.
    if (!courses.some((c) => c.current)) for (const c of courses) c.current = true;
    assignColors(courses);
    this.report.term = { enrolled: rows.length, read: courses.length, current: courses.filter((c) => c.current).length, otherTerm };
    for (const c of courses) this.report.courses.push({ orgUnitId: c.orgUnitId, code: c.code, current: c.current, tools: {} });
    return courses;
  }

  async listDeadlines(course) {
    const rep = this.report.courses.find((c) => c.orgUnitId === course.orgUnitId) || { tools: {} };
    const rows = await this.paged(`/api/v1/courses/${course.orgUnitId}/assignments?include[]=submission&order_by=due_at&per_page=100`);
    const from = this.now.getTime() - KEEP_BEFORE_MS;
    const items = [];
    for (const a of rows) {
      if (!a || a.id == null || a.published === false) continue;
      const due = isoOrNull(a.due_at) || isoOrNull(a.lock_at);
      if (!due || Date.parse(due) < from) continue;
      const kind = kindOf(a);
      const title = String(a.name || "Assignment").trim();
      const completedAt = handedInAt(a.submission);
      const opens = isoOrNull(a.unlock_at);
      const item = {
        id: `${course.orgUnitId}:${kind}:${a.id}`,
        courseId: course.id,
        kind,
        category: categoryFor(kind, title),
        title,
        dueAt: due,
        dueField: a.due_at ? "due" : "end",
        url: a.html_url || `${this.base}/courses/${course.orgUnitId}/assignments/${a.id}`,
        listUrl: `${this.base}/courses/${course.orgUnitId}/assignments`,
        status: completedAt ? "submitted" : "open",
        completedAt,
        moved: null,
        seenIn: ["canvas"],
      };
      if (opens && opens < due) item.opensAt = opens;
      items.push(item);
    }
    this.readOk.set(course.id, new Set(["canvas"]));
    rep.tools.assignments = rows.length;
    rep.items = items.length;
    rep.submitted = items.filter((i) => i.status === "submitted").length;
    return items;
  }

  /** A course with no dates is kept only with something open from today on, and then only its items from two weeks back. */
  keepTermless(course, items) {
    const now = this.now.getTime();
    const upcoming = items.filter((i) => i.status === "open" && Date.parse(i.dueAt) >= now);
    if (!upcoming.length) return null;
    return items.filter((i) => Date.parse(i.dueAt) >= now - 14 * DAY_MS);
  }

  /**
   * Asks Canvas whether one assignment is handed in. Resolves to
   * { submitted: true, at } or { submitted: false }, or null when Canvas could
   * not be asked.
   */
  async submissionState(item) {
    const [courseId, , assignmentId] = String(item.id || "").split(":");
    if (!/^\d+$/.test(courseId || "") || !/^\d+$/.test(assignmentId || "")) return null;
    const vias = this.relay ? ["worker", "tab"] : ["worker"];
    for (const via of vias) {
      try {
        const { json } = await this.api(`/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/self`, { via });
        const at = handedInAt(json);
        return at ? { submitted: true, at } : { submitted: false };
      } catch (e) {
        this.report.notes.push(`submission check via ${via} failed (${e.code || "error"})`);
      }
    }
    return null;
  }

  /** Called by the background once a read ends. */
  finishReport(extra = {}) {
    Object.assign(this.report, extra, { finishedAt: new Date().toISOString() });
    this.report.failedRequests = this.report.requests.filter((r) => r.error).length;
    return this.report;
  }
}
