// tests/librarySync.test.js — reconciling the local library with the server.
// Run: node --test tests/librarySync.test.js

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// localStore.js talks to a global localStorage; stub it before importing.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const {
  foldServerRecords,
  applyServerRecords,
  pickSeedRecords,
  pickSeedFavorites,
  isPushableRecord,
  isAcceptableRecord,
  serverRecordKey,
  LibrarySync,
} = await import("../js/core/storage/librarySync.js");
const { LocalLibrary } = await import("../js/core/storage/localLibrary.js");

const rec = (over = {}) => ({
  title: "流浪地球2", year: "2023", source_name: "猫眼资源",
  index: 1, play_time: 100, total_time: 7200, save_time: 1000, ...over,
});

describe("local outro marks", () => {
  beforeEach(() => store.clear());

  test("use the per-title key and stay separate from play-record replacement", () => {
    const key = LocalLibrary.recordKeyForTitle("流浪地球2", "2023");
    LocalLibrary.saveOutroMark(key, { fromEnd: 42, markedAt: 123 });
    LocalLibrary.replaceRecords({ "流浪地球2|2023": rec() });

    assert.deepEqual(LocalLibrary.getOutroMark(key), { fromEnd: 42, markedAt: 123 });
    assert.deepEqual(LocalLibrary.getOutroMarks(), {
      "流浪地球2|2023": { fromEnd: 42, markedAt: 123 }
    });
  });

  test("delete only removes the selected title mark", () => {
    LocalLibrary.saveOutroMark("a|2020", { fromEnd: 10, markedAt: 1 });
    LocalLibrary.saveOutroMark("b|2021", { fromEnd: 20, markedAt: 2 });
    LocalLibrary.deleteOutroMark("a|2020");

    assert.equal(LocalLibrary.getOutroMark("a|2020"), null);
    assert.deepEqual(LocalLibrary.getOutroMark("b|2021"), { fromEnd: 20, markedAt: 2 });
  });
});

describe("foldServerRecords", () => {
  test("per-source server keys collapse onto one per-title entry", () => {
    const folded = foldServerRecords({
      "maoyan+137": rec({ save_time: 100 }),
      "modu+900": rec({ save_time: 500, play_time: 4000 }),
    });
    assert.deepEqual(Object.keys(folded), ["流浪地球2|2023"]);
    assert.equal(folded["流浪地球2|2023"].play_time, 4000);
  });

  test("the newest save_time wins regardless of iteration order", () => {
    const newest = foldServerRecords({
      "a+1": rec({ save_time: 900, play_time: 9 }),
      "b+2": rec({ save_time: 100, play_time: 1 }),
    });
    assert.equal(newest["流浪地球2|2023"].play_time, 9);
  });

  test("the winning entry carries back the source it came from", () => {
    const folded = foldServerRecords({ "modu+900": rec() });
    const one = folded["流浪地球2|2023"];
    assert.equal(one.source, "modu");
    assert.equal(one.id, "900");
    assert.equal(serverRecordKey(one), "modu+900");
  });

  test("different titles stay separate, same title different year too", () => {
    const folded = foldServerRecords({
      "a+1": rec(),
      "b+2": rec({ title: "满江红" }),
      "c+3": rec({ year: "2019" }),
    });
    assert.equal(Object.keys(folded).length, 3);
  });

  test("entries without a title are skipped rather than keyed as empty", () => {
    assert.deepEqual(foldServerRecords({ "a+1": { save_time: 1 } }), {});
  });

  test("a missing or malformed payload folds to nothing", () => {
    assert.deepEqual(foldServerRecords(null), {});
    assert.deepEqual(foldServerRecords({}), {});
  });
});

describe("applyServerRecords", () => {
  test("the server replaces local state, so remote deletions propagate", () => {
    const local = { "满江红|2023": rec({ title: "满江红", source: "a", id: "1" }) };
    const next = applyServerRecords(local, {});
    assert.deepEqual(next, {}, "a record the server no longer has must go");
  });

  test("legacy records with no source/id survive — they can never be pushed", () => {
    const legacy = rec({ title: "老记录" });
    delete legacy.source;
    const next = applyServerRecords({ "老记录|2023": legacy }, {});
    assert.deepEqual(Object.keys(next), ["老记录|2023"]);
  });

  test("but the server still wins when it has that same title", () => {
    const legacy = rec({ title: "老记录", play_time: 1 });
    const server = { "老记录|2023": rec({ title: "老记录", play_time: 999, source: "a", id: "2" }) };
    const next = applyServerRecords({ "老记录|2023": legacy }, server);
    assert.equal(next["老记录|2023"].play_time, 999);
  });
});

describe("seeding a server for the first time", () => {
  test("local records the server lacks are uploaded", () => {
    const local = { "流浪地球2|2023": rec({ source: "a", id: "1" }) };
    assert.equal(pickSeedRecords(local, {}).length, 1);
  });

  test("a newer local record overwrites an older remote one", () => {
    const local = { "流浪地球2|2023": rec({ source: "a", id: "1", save_time: 500 }) };
    assert.equal(pickSeedRecords(local, { "流浪地球2|2023": rec({ save_time: 100 }) }).length, 1);
    assert.equal(pickSeedRecords(local, { "流浪地球2|2023": rec({ save_time: 900 }) }).length, 0);
  });

  test("unpushable records are left out instead of failing the upload", () => {
    const legacy = rec();
    delete legacy.source;
    assert.equal(pickSeedRecords({ "流浪地球2|2023": legacy }, {}).length, 0);
  });

  test("favorites already on the server are not re-uploaded", () => {
    const local = { "a+1": { title: "x" }, "b+2": { title: "y" } };
    const picked = pickSeedFavorites(local, { "a+1": { title: "x" } });
    assert.deepEqual(picked.map(([k]) => k), ["b+2"]);
  });
});

describe("server input validation mirrors what the API accepts", () => {
  test("a record needs a title, a source name and a 1-based index", () => {
    assert.equal(isAcceptableRecord(rec()), true);
    assert.equal(isAcceptableRecord(rec({ index: 0 })), false, "index is 1-based");
    assert.equal(isAcceptableRecord(rec({ title: "" })), false);
    assert.equal(isAcceptableRecord(rec({ source_name: "" })), false);
  });

  test("pushability is about the key, acceptability about the payload", () => {
    assert.equal(isPushableRecord(rec({ source: "a", id: "1" })), true);
    assert.equal(isPushableRecord(rec({ source: "a" })), false);
    assert.equal(isPushableRecord(null), false);
  });
});

describe("the mirror stays out of the way when it cannot work", () => {
  beforeEach(() => {
    store.clear();
    LibrarySync.failures = 0;
  });

  test("anonymous browsing pushes nothing", () => {
    let called = 0;
    LibrarySync.configure({
      api: { addFavorite: () => { called++; return Promise.resolve(); } },
      isEnabled: () => false,
    });
    LibrarySync.pushFavorite("a+1", { title: "x" });
    assert.equal(called, 0);
  });

  test("a pull that throws leaves local state untouched", async () => {
    LocalLibrary.replaceFavorites({ "a+1": { title: "keep me" } });
    LibrarySync.configure({
      api: {
        getStoredBaseUrl: () => "http://tv.local",
        hasPersistedSession: () => Promise.resolve(true),
        getFavorites: () => Promise.reject(new Error("offline")),
        getPlayRecords: () => Promise.reject(new Error("offline")),
      },
      isEnabled: () => true,
    });
    assert.equal(await LibrarySync.pull(), false);
    assert.deepEqual(LocalLibrary.getFavorites(), { "a+1": { title: "keep me" } });
  });

  test("a public-mode server is detected and left alone entirely", async () => {
    // /api/login answers ok with no cookie in public mode, so credentials are
    // no proof of a session and every per-user endpoint would 401.
    let touched = 0;
    LocalLibrary.replaceFavorites({ "a+1": { title: "stays put" } });
    LibrarySync.configure({
      api: {
        getStoredBaseUrl: () => "http://tv.local",
        hasPersistedSession: () => Promise.resolve(false),
        getFavorites: () => { touched++; return Promise.resolve({}); },
        getPlayRecords: () => { touched++; return Promise.resolve({}); },
      },
      isEnabled: () => true,
    });
    assert.equal(await LibrarySync.pull(), false);
    assert.equal(touched, 0, "no per-user endpoint is even attempted");
    assert.deepEqual(LocalLibrary.getFavorites(), { "a+1": { title: "stays put" } });

    LibrarySync.pushFavorite("b+2", { title: "x" });
    assert.equal(LibrarySync.serverBacked, false, "pushes stay disabled too");
  });

  test("nothing is pushed before a pull has proven there is a session", () => {
    let called = 0;
    LibrarySync.configure({
      api: { addFavorite: () => { called++; return Promise.resolve(); } },
      isEnabled: () => true,
    });
    LibrarySync.pushFavorite("a+1", { title: "x" });
    assert.equal(called, 0);
  });

  test("repeated push failures trip the breaker instead of retrying forever", async () => {
    let attempts = 0;
    LibrarySync.configure({
      api: {
        savePlayRecord: () => { attempts++; return Promise.reject(new Error("nope")); },
      },
      isEnabled: () => true,
    });
    LibrarySync.serverBacked = true;
    for (let i = 0; i < 10; i++) {
      LibrarySync.pushRecord(rec({ source: "a", id: "1" }));
      await Promise.resolve();
    }
    assert.equal(attempts, 3, "stops after the failure limit");
  });

  test("a successful pull re-arms the breaker", async () => {
    LibrarySync.failures = 99;
    LibrarySync.configure({
      api: {
        getStoredBaseUrl: () => "http://tv.local",
        hasPersistedSession: () => Promise.resolve(true),
        getFavorites: () => Promise.resolve({}),
        getPlayRecords: () => Promise.resolve({}),
      },
      isEnabled: () => true,
    });
    store.set("decotv.sync.seededServers", JSON.stringify(["http://tv.local"]));
    await LibrarySync.pull();
    assert.equal(LibrarySync.failures, 0);
  });
});

describe("pull end to end", () => {
  beforeEach(() => {
    store.clear();
    LibrarySync.failures = 0;
  });

  test("first contact seeds the server, then adopts it as the truth", async () => {
    LocalLibrary.replaceRecords({ "本地片|2020": rec({ title: "本地片", year: "2020", source: "a", id: "1" }) });
    LocalLibrary.replaceFavorites({ "a+1": { title: "本地收藏", source_name: "s" } });

    const uploaded = { favorites: [], records: [] };
    let serverRecords = { "b+2": rec({ title: "服务端片", year: "2021" }) };
    let serverFavorites = {};

    LibrarySync.configure({
      api: {
        getStoredBaseUrl: () => "http://tv.local",
        hasPersistedSession: () => Promise.resolve(true),
        getFavorites: () => Promise.resolve(serverFavorites),
        getPlayRecords: () => Promise.resolve(serverRecords),
        addFavorite: (k, f) => {
          uploaded.favorites.push(k); serverFavorites = { ...serverFavorites, [k]: f };
          return Promise.resolve();
        },
        savePlayRecord: (k, r) => {
          uploaded.records.push(k); serverRecords = { ...serverRecords, [k]: r };
          return Promise.resolve();
        },
      },
      isEnabled: () => true,
    });

    assert.equal(await LibrarySync.pull(), true);
    assert.deepEqual(uploaded.favorites, ["a+1"], "local favorite is seeded up");
    assert.deepEqual(uploaded.records, ["a+1"], "local record is seeded up");

    const records = LocalLibrary.getPlayRecords();
    assert.ok(records["本地片|2020"], "seeded local record survives");
    assert.ok(records["服务端片|2021"], "server record arrives");
    assert.ok(LocalLibrary.getFavorites()["a+1"]);
  });

  test("a failed seed upload leaves local state alone and does not mark seeded", async () => {
    LocalLibrary.replaceRecords({ "本地片|2020": rec({ title: "本地片", year: "2020", source: "a", id: "1" }) });
    LocalLibrary.replaceFavorites({});
    LibrarySync.configure({
      api: {
        getStoredBaseUrl: () => "http://tv.local",
        hasPersistedSession: () => Promise.resolve(true),
        getFavorites: () => Promise.resolve({}),
        getPlayRecords: () => Promise.resolve({}),
        savePlayRecord: () => Promise.reject(new Error("write failed")),
      },
      isEnabled: () => true,
    });
    assert.equal(await LibrarySync.pull(), false);
    assert.ok(
      LocalLibrary.getPlayRecords()["本地片|2020"],
      "a record that failed to upload must not then be deleted as absent upstream",
    );
    assert.deepEqual(JSON.parse(store.get("decotv.sync.seededServers") || "[]"), []);
  });

  test("once seeded, a favorite deleted elsewhere disappears here too", async () => {
    store.set("decotv.sync.seededServers", JSON.stringify(["http://tv.local"]));
    LocalLibrary.replaceFavorites({ "gone+1": { title: "deleted on the web" } });
    LibrarySync.configure({
      api: {
        getStoredBaseUrl: () => "http://tv.local",
        hasPersistedSession: () => Promise.resolve(true),
        getFavorites: () => Promise.resolve({}),
        getPlayRecords: () => Promise.resolve({}),
      },
      isEnabled: () => true,
    });
    await LibrarySync.pull();
    assert.deepEqual(LocalLibrary.getFavorites(), {});
  });
});
