// Crowdmark for a school other than Waterloo (UofT): who is offered it, where
// they sign in, and whether a UofT Crowdmark course lands under its Quercus one.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = {
  permissions: { contains: async () => true },
  runtime: { getURL: () => "chrome-extension://test/" },
};

const { crowdmarkSignIn, crowdmarkOffered, crowdmarkAllowed, parseCrowdmarkCourse, readCrowdmark } = await import("../extension/src/data/crowdmark-source.js");

const NOW = new Date("2026-10-13T12:00:00Z");

describe("which schools get Crowdmark", () => {
  test("Waterloo and UofT, and an install from before the school picker", async () => {
    assert.equal(crowdmarkOffered({ school: "uwaterloo" }), true);
    assert.equal(crowdmarkOffered({ school: "utoronto" }), true);
    assert.equal(crowdmarkOffered({ school: null }), true, "older installs read Waterloo");
    assert.equal(crowdmarkOffered({ school: "uoguelph" }), false);
    assert.equal(await crowdmarkAllowed({ school: "utoronto" }), true);
    assert.equal(await crowdmarkAllowed({ school: "uoguelph" }), false);
  });

  test("each school signs in on its own Crowdmark page", () => {
    assert.equal(crowdmarkSignIn({ school: "uwaterloo" }), "https://app.crowdmark.com/sign-in/waterloo");
    assert.equal(crowdmarkSignIn({ school: "utoronto" }), "https://app.crowdmark.com/sign-in/utoronto");
    assert.equal(crowdmarkSignIn({ school: null }), "https://app.crowdmark.com/sign-in/waterloo");
  });
});

describe("UofT course names", () => {
  test("the code Quercus uses, with or without a section", () => {
    assert.deepEqual(parseCrowdmarkCourse("CHM135H1 F LEC0101 Fall 2026", "x"), { code: "CHM135H1", term: 1269, hasCode: true });
    assert.deepEqual(parseCrowdmarkCourse("CHM135H1F: Chemistry", "x"), { code: "CHM135H1", term: null, hasCode: true });
  });

  test("Waterloo names read as before", () => {
    assert.deepEqual(parseCrowdmarkCourse("ECE 207 - Fall 2026", "x"), { code: "ECE 207", term: 1269, hasCode: true });
  });
});

describe("a UofT Crowdmark course joins its Quercus course", () => {
  test("assignments land under CHM135H1 from Quercus", async () => {
    const quercus = [{ id: "cv555", code: "CHM135H1", name: "Chemistry: Physical Principles", orgUnitId: 555, color: "blue" }];
    const bodies = {
      courses: { data: [{ id: "chm135h1-f-2026", type: "courses", attributes: { name: "CHM135H1F: Chemistry" }, relationships: {} }] },
      assignments: {
        data: [{ id: "cm-1", type: "assignments", attributes: { due: "2026-10-20T03:59:00Z", "submitted-at": null, "is-locked": false }, relationships: { "exam-master": { data: { type: "exam-masters", id: "em-1" } } } }],
        included: [{ type: "exam-masters", id: "em-1", attributes: { title: "Problem Set 2", type: "assigned" } }],
      },
    };
    globalThis.fetch = async (url) => ({
      ok: true,
      status: 200,
      url,
      redirected: false,
      headers: { get: () => "application/vnd.api+json" },
      json: async () => (String(url).includes("/student/courses") ? bodies.courses : bodies.assignments),
    });
    const out = await readCrowdmark({ school: "utoronto" }, quercus, { now: NOW });
    assert.equal(out.status, "ok");
    assert.deepEqual(out.courses, [], "no separate Crowdmark course: it matched Quercus");
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].courseId, "cv555");
    assert.equal(out.items[0].title, "Problem Set 2");
    assert.equal(out.items[0].kind, "crowdmark");
  });
});
