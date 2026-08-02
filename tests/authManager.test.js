// tests/authManager.test.js — what counts as being signed in, and to whom.
// Run: node --test tests/authManager.test.js

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map([["decotv.lang", '"en"']]);
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const { AuthManager, AuthState } = await import("../js/core/auth/authManager.js");
const { api } = await import("../js/core/network/decotvClient.js");

const SERVER_A = "http://a.local:4000";
const SERVER_B = "http://b.local:4000";
const PASSWORD_MODE = { AuthMode: "password", StorageType: "kvrocks" };
const PUBLIC_MODE = { AuthMode: "public", StorageType: "kvrocks" };

let calls;

// Stub only the network surface; setBaseUrl/getStoredBaseUrl run for real so
// the per-server keying is exercised against the same storage the app uses.
function stubApi({ config = PASSWORD_MODE, hasCookie = false, sessionValid = false, loginThrows = false } = {}) {
  calls = { login: [], verify: 0 };
  api.getServerConfig = async () => config;
  api.setStoredServerConfig = () => {};
  api.hasPersistedSession = async () => hasCookie;
  api.verifySession = async () => { calls.verify++; return sessionValid; };
  api.login = async (username, password) => {
    calls.login.push({ username, password });
    if (loginThrows) throw new Error("UNAUTHORIZED");
    return { ok: true };
  };
}

beforeEach(() => {
  store.clear();
  store.set("decotv.lang", '"en"');
  AuthManager.serverConfig = null;
  AuthManager.loggedInUser = null;
  AuthManager._accountSession = false;
  AuthManager._ensuring = null;
  api.setBaseUrl(SERVER_A);
});

describe("credentials belong to one server", () => {
  test("they are not handed to a different server", () => {
    stubApi();
    AuthManager.setStoredCredentials({ username: "pi", password: "secret" });
    api.setBaseUrl(SERVER_B);
    assert.equal(AuthManager.getStoredCredentials(), null);
  });

  test("each server keeps its own", () => {
    stubApi();
    AuthManager.setStoredCredentials({ username: "a-user", password: "a-pass" });
    api.setBaseUrl(SERVER_B);
    AuthManager.setStoredCredentials({ username: "b-user", password: "b-pass" });
    assert.equal(AuthManager.getStoredCredentials().username, "b-user");
    api.setBaseUrl(SERVER_A);
    assert.equal(AuthManager.getStoredCredentials().username, "a-user");
  });

  test("clearing one leaves the other alone", () => {
    stubApi();
    AuthManager.setStoredCredentials({ username: "a-user", password: "a-pass" });
    api.setBaseUrl(SERVER_B);
    AuthManager.setStoredCredentials({ username: "b-user", password: "b-pass" });
    AuthManager.setStoredCredentials(null);
    assert.equal(AuthManager.getStoredCredentials(), null);
    api.setBaseUrl(SERVER_A);
    assert.equal(AuthManager.getStoredCredentials().username, "a-user");
  });

  test("the old flat record is attributed to the configured server", () => {
    stubApi();
    store.set("decotv.credentials", JSON.stringify({ username: "legacy", password: "p" }));
    assert.equal(AuthManager.getStoredCredentials().username, "legacy");
    api.setBaseUrl(SERVER_B);
    assert.equal(AuthManager.getStoredCredentials(), null, "not inherited by another server");
  });

  test("connecting to a new server sends it no password", async () => {
    stubApi({ config: PASSWORD_MODE });
    AuthManager.setStoredCredentials({ username: "pi", password: "secret" });
    const states = [];
    const off = AuthManager.subscribe((s) => states.push(s));
    await AuthManager.connect(SERVER_B);
    off();
    assert.deepEqual(calls.login, [], "no credentials were transmitted");
    assert.equal(states.at(-1), AuthState.NEED_LOGIN);
  });
});

describe("a session only counts once the server accepts it", () => {
  test("a cookie the server no longer honours is not a session", async () => {
    stubApi({ hasCookie: true, sessionValid: false });
    assert.equal(await AuthManager._establishSession(), false);
    assert.equal(AuthManager.loggedInUser, null);
  });

  test("a cookie the server still honours is", async () => {
    stubApi({ hasCookie: true, sessionValid: true });
    AuthManager.setStoredCredentials({ username: "pi", password: "secret" });
    assert.equal(await AuthManager._establishSession(), true);
    assert.equal(AuthManager.loggedInUser, "pi");
  });

  test("a login answering ok without issuing one is not either", async () => {
    // The public-mode shape: /api/login returns {ok:true} and sets no cookie.
    stubApi({ config: PASSWORD_MODE, sessionValid: false });
    AuthManager.setStoredCredentials({ username: "pi", password: "secret" });
    AuthManager.serverConfig = PASSWORD_MODE;
    assert.equal(await AuthManager._establishSession(), false);
    assert.ok(calls.login.length > 0, "it did try");
    assert.equal(AuthManager.loggedInUser, null);
  });

  test("stale loggedInUser is cleared rather than left behind", async () => {
    stubApi({ hasCookie: false, sessionValid: false });
    AuthManager.loggedInUser = "someone";
    AuthManager._accountSession = true;
    await AuthManager._establishSession();
    assert.equal(AuthManager.loggedInUser, null);
    assert.equal(AuthManager.hasAccountSession(), false);
  });
});

describe("an account session is not the same as knowing the username", () => {
  // The auth cookie lives in the JS service's store and the credentials in
  // webview localStorage — separate stores that can diverge. Gating sync on
  // isLoggedIn() in that state silently disabled it despite a session the
  // server still honoured.
  test("a valid cookie with the credentials gone still counts as an account session", async () => {
    stubApi({ hasCookie: true, sessionValid: true });
    assert.equal(await AuthManager._establishSession(), true);
    assert.equal(AuthManager.loggedInUser, null, "the username is unknown");
    assert.equal(AuthManager.isLoggedIn(), false);
    assert.equal(AuthManager.hasAccountSession(), true, "but the session is real");
  });

  test("anonymous browsing on a public server is not an account session", async () => {
    stubApi({ config: PUBLIC_MODE, sessionValid: false });
    AuthManager.serverConfig = PUBLIC_MODE;
    assert.equal(await AuthManager._establishSession(), true);
    assert.equal(AuthManager.hasAccountSession(), false);
  });

  test("logout drops the account session", async () => {
    stubApi({ config: PASSWORD_MODE, sessionValid: true });
    api.logout = async () => {};
    await AuthManager.loginWithCredentials("pi", "secret");
    assert.equal(AuthManager.hasAccountSession(), true);
    AuthManager.serverConfig = PASSWORD_MODE;
    await AuthManager.logout();
    assert.equal(AuthManager.hasAccountSession(), false);
  });
});

describe("what each server mode leads to", () => {
  test("a password server with no usable session asks for a login", async () => {
    stubApi({ config: PASSWORD_MODE, hasCookie: true, sessionValid: false });
    const states = [];
    const off = AuthManager.subscribe((s) => states.push(s));
    await AuthManager.connect(SERVER_A);
    off();
    assert.equal(states.at(-1), AuthState.NEED_LOGIN);
  });

  test("a public server browses anonymously instead of claiming a login", async () => {
    stubApi({ config: PUBLIC_MODE, sessionValid: false });
    AuthManager.setStoredCredentials({ username: "pi", password: "secret" });
    const states = [];
    const off = AuthManager.subscribe((s) => states.push(s));
    await AuthManager.connect(SERVER_A);
    off();
    assert.equal(states.at(-1), AuthState.AUTHENTICATED);
    assert.equal(AuthManager.loggedInUser, null, "anonymous is not signed in");
    assert.equal(AuthManager.isLoggedIn(), false);
  });

  test("a verified account session reaches home as signed in", async () => {
    stubApi({ config: PASSWORD_MODE, hasCookie: true, sessionValid: true });
    AuthManager.setStoredCredentials({ username: "pi", password: "secret" });
    const states = [];
    const off = AuthManager.subscribe((s) => states.push(s));
    await AuthManager.connect(SERVER_A);
    off();
    assert.equal(states.at(-1), AuthState.AUTHENTICATED);
    assert.equal(AuthManager.isLoggedIn(), true);
  });
});

describe("signing in by hand", () => {
  test("credentials the server will not honour are rejected, not stored", async () => {
    stubApi({ config: PASSWORD_MODE, sessionValid: false });
    const states = [];
    const off = AuthManager.subscribe((s) => states.push(s));
    await AuthManager.loginWithCredentials("pi", "secret");
    off();
    assert.equal(states.at(-1), AuthState.NEED_LOGIN);
    assert.equal(AuthManager.getStoredCredentials(), null, "nothing worth replaying was saved");
    assert.equal(AuthManager.isLoggedIn(), false);
  });

  test("accepted credentials are stored against that server only", async () => {
    stubApi({ config: PASSWORD_MODE, sessionValid: true });
    await AuthManager.loginWithCredentials("pi", "secret");
    assert.equal(AuthManager.isLoggedIn(), true);
    assert.equal(AuthManager.getStoredCredentials().username, "pi");
    api.setBaseUrl(SERVER_B);
    assert.equal(AuthManager.getStoredCredentials(), null);
  });
});
