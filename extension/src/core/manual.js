/*
  Deadlines the student adds themselves.

  For a course whose prof doesn't post on the school's site, or anything that
  isn't on it at all (Marmoset, Möbius, work handed in on paper, a club). They
  are ordinary Deadline objects, so the list, reminders, badge, check-off and
  calendar file treat them like any other, with kind "manual" so nothing ever
  asks the school's site whether they were handed in.

  They live under their own storage key, not in state, because every read of
  the school's site rebuilds state.items from what the site returned. mutate()
  in background.js puts them back after every write (applyManual), so no read,
  failed read or course change can lose one. Delete my data clears them with
  everything else.

  An item keeps the course it was added under. If that course isn't in the list
  any more (a new term, a school change), it shows under "Personal" instead of
  disappearing, and goes back to its course if the course returns.
*/

export const MANUAL_KEY = "manualItems";
export const PERSONAL_ID = "personal";
export const PERSONAL_COURSE = { id: PERSONAL_ID, code: "Personal", name: "Added by you", color: "violet", orgUnitId: 0, current: true, manual: true };

export const MANUAL_CATEGORIES = ["assignment", "lab", "quiz", "discussion", "content"];
const MAX_TITLE = 120;
const MAX_URL = 2000;

/**
 * Checks what the add/edit form sent and turns it into a stored item.
 * Resolves to { item } or { error } with words the form can show.
 * @param {object} input   { id?, title, courseId, category, dueAt, url? }
 * @param {object} [prev]  The stored item being edited, to keep its status
 */
export function validateManual(input, prev = null, now = new Date()) {
  const title = String((input && input.title) || "").replace(/\s+/g, " ").trim();
  if (!title) return { error: "Give it a name." };
  if (title.length > MAX_TITLE) return { error: `Keep the name under ${MAX_TITLE} characters.` };
  const due = Date.parse(input.dueAt);
  if (!Number.isFinite(due)) return { error: "Pick a due date and time." };
  const category = MANUAL_CATEGORIES.includes(input.category) ? input.category : "assignment";
  let url = String(input.url || "").trim();
  if (url) {
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
      url = u.href.slice(0, MAX_URL);
    } catch {
      return { error: "The link has to start with https://" };
    }
  }
  const dueAt = new Date(due).toISOString();
  const item = {
    id: prev ? prev.id : `manual:${crypto.randomUUID()}`,
    courseId: String(input.courseId || PERSONAL_ID),
    kind: "manual",
    manual: true,
    category,
    title,
    dueAt,
    dueField: "due",
    url,
    status: prev ? prev.status : "open",
    completedAt: prev ? prev.completedAt : null,
    moved: null,
    createdAt: prev ? prev.createdAt : now.toISOString(),
  };
  return { item };
}

/**
 * Puts the stored items into a state: removes whatever manual items it had and
 * adds the stored ones, each under its own course when that course is there,
 * under Personal otherwise. Adds the Personal course when something needs it,
 * and takes it away when nothing does.
 */
export function applyManual(state, manual) {
  if (!state || !Array.isArray(state.items)) return state;
  const list = Array.isArray(manual) ? manual : [];
  const courses = (state.courses || []).filter((c) => c.id !== PERSONAL_ID);
  const known = new Set(courses.map((c) => c.id));
  const placed = list.map((m) => ({ ...m, courseId: known.has(m.courseId) ? m.courseId : PERSONAL_ID }));
  state.items = state.items.filter((i) => !i.manual).concat(placed);
  state.courses = placed.some((m) => m.courseId === PERSONAL_ID) ? [...courses, { ...PERSONAL_COURSE }] : courses;
  return state;
}
