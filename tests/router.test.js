// test/router.test.js — tests for Router stack semantics.
// Run: node --test tests/router.test.js

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Minimal window stub so router.js doesn't crash on import.
globalThis.window = {
  history: { pushState() {}, replaceState() {} },
  addEventListener() {},
};
globalThis.webOSSystem = undefined;

const { Router } = await import("../js/ui/navigation/router.js");

// Create a fresh Router clone for each test (Router is a singleton object).
function freshRouter() {
  return Object.create(Router);
}

// A mock screen that records mount/cleanup calls.
function mockScreen(name) {
  const calls = [];
  return {
    calls,
    name,
    async mount(params, opts) {
      calls.push({ type: "mount", params, opts });
    },
    cleanup() {
      calls.push({ type: "cleanup" });
    },
    consumeBackRequest() {
      return false;
    },
  };
}

describe("Router stack semantics", () => {
  let r;

  beforeEach(() => {
    r = freshRouter();
    r.current = null;
    r.currentParams = {};
    r.stack = [];
    r.routes = {};

    const home = mockScreen("home");
    const detail = mockScreen("detail");
    const player = mockScreen("player");
    r.register("home", home);
    r.register("detail", detail);
    r.register("player", player);
    r._screens = { home, detail, player };
  });

  test("navigate pushes previous route onto stack", async () => {
    await r.navigate("home", {});
    assert.equal(r.current, "home");
    assert.equal(r.stack.length, 0);

    await r.navigate("detail", { title: "Movie A" });
    assert.equal(r.current, "detail");
    assert.equal(r.stack.length, 1);
    assert.equal(r.stack[0].route, "home");
  });

  test("back pops stack and remounts previous", async () => {
    await r.navigate("home", {});
    await r.navigate("detail", { title: "Movie A" });
    await r.navigate("player", { url: "http://example.com" });

    assert.equal(r.stack.length, 2);
    assert.equal(r.current, "player");

    await r.back();
    assert.equal(r.current, "detail");
    assert.equal(r.stack.length, 1);

    // Verify detail was remounted with original params
    const detailCalls = r._screens.detail.calls;
    const lastMount = detailCalls.filter((c) => c.type === "mount").pop();
    assert.deepEqual(lastMount.params, { title: "Movie A" });
    assert.equal(lastMount.opts.fromHistory, true);
  });

  test("back on home calls webOSSystem.close (no crash)", async () => {
    await r.navigate("home", {});
    // back() on home should not throw even without webOSSystem
    await r.back();
    assert.equal(r.current, "home");
  });

  test("navigate to same route cleans up but doesn't push stack", async () => {
    await r.navigate("home", {});
    await r.navigate("home", {});
    assert.equal(r.stack.length, 0);
    // cleanup should have been called
    const homeCalls = r._screens.home.calls;
    assert.ok(homeCalls.some((c) => c.type === "cleanup"));
  });

  test("back with empty stack falls back to home", async () => {
    await r.navigate("detail", { title: "X" });
    assert.equal(r.stack.length, 0); // nothing before detail

    await r.back();
    assert.equal(r.current, "home");
  });

  test("cleanup is called on previous screen when navigating away", async () => {
    await r.navigate("home", {});
    await r.navigate("detail", {});
    const homeCalls = r._screens.home.calls;
    assert.ok(homeCalls.some((c) => c.type === "cleanup"));
  });

  test("NON_BACKSTACK_ROUTES: splash doesn't push to stack", async () => {
    const splash = mockScreen("splash");
    r.register("splash", splash);

    await r.navigate("splash", {});
    await r.navigate("home", {});
    // splash should NOT be on the stack (it's in NON_BACKSTACK_ROUTES)
    assert.equal(r.stack.length, 0);
  });

  test("getCurrentScreen returns the current screen object", async () => {
    await r.navigate("home", {});
    assert.equal(r.getCurrentScreen(), r._screens.home);
  });
});
