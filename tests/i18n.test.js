// tests/i18n.test.js — tests for the translation table and language selection.
// Run: node --test tests/i18n.test.js

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Minimal localStorage stub so localStore.js works under node. Must exist
// before importing i18n.js — the module resolves the active language at load.
// Seeding a stored language keeps that resolution deterministic without
// touching navigator, which node defines as a getter-only global.
const store = new Map([["decotv.lang", '"en"']]);
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const { t, setLang, getLang, nextLang, detectLang, LANGS } =
  await import("../js/core/i18n.js");

describe("detectLang", () => {
  test("every Chinese tag resolves to zh-CN", () => {
    for (const tag of ["zh", "zh-CN", "zh-TW", "zh-Hans", "ZH-HK"]) {
      assert.equal(detectLang(tag), "zh-CN", tag);
    }
  });

  test("everything else falls back to English", () => {
    for (const tag of ["en", "en-US", "ja-JP", "ko-KR", "de", "", null, undefined]) {
      assert.equal(detectLang(tag), "en", String(tag));
    }
  });
});

describe("dictionary integrity", () => {
  // Read the source rather than exporting DICT: the table is an implementation
  // detail, but a key present in one language and missing in the other is a
  // real bug that silently falls back to English.
  const src = readFileSync(new URL("../js/core/i18n.js", import.meta.url), "utf8");
  const zhBlock = src.slice(src.indexOf('"zh-CN": {'), src.indexOf("  en: {"));
  const enBlock = src.slice(src.indexOf("  en: {"));
  const keysOf = (block) => [...block.matchAll(/^\s{4}"([\w.]+)":/gm)].map((m) => m[1]);

  const zhKeys = keysOf(zhBlock);
  const enKeys = keysOf(enBlock);

  test("both languages define the same keys", () => {
    assert.deepEqual([...zhKeys].sort(), [...enKeys].sort());
  });

  test("no duplicate keys within a language", () => {
    assert.equal(new Set(zhKeys).size, zhKeys.length);
    assert.equal(new Set(enKeys).size, enKeys.length);
  });

  test("no key resolves to an empty string in either language", () => {
    for (const lang of LANGS) {
      setLang(lang);
      for (const key of zhKeys) {
        assert.notEqual(t(key).trim(), "", `${lang} / ${key}`);
      }
    }
  });

  test("English strings carry no CJK characters", () => {
    setLang("en");
    for (const key of enKeys) {
      assert.doesNotMatch(t(key), /[\u4e00-\u9fff]/, key);
    }
  });
});

describe("nav header tabs", () => {
  const nav = readFileSync(new URL("../js/ui/navigation/navHeader.js", import.meta.url), "utf8");

  test("every labelKey resolves in both languages", () => {
    const keys = [...nav.matchAll(/labelKey:\s*"([\w.]+)"/g)].map((m) => m[1]);
    assert.equal(keys.length, 12);
    for (const lang of LANGS) {
      setLang(lang);
      for (const key of keys) assert.notEqual(t(key), key, `${lang} / ${key}`);
    }
  });

  test("no tab carries a hardcoded label", () => {
    assert.doesNotMatch(nav, /^\s*\{ action:.*\blabel:/m);
  });

  // The whole point of translating only the label: params.type is a slug sent
  // to the server, so a well-meaning search-and-replace must never reach it.
  test("route params stay ASCII slugs", () => {
    for (const [, slug] of nav.matchAll(/type:\s*"([^"]*)"/g)) {
      assert.match(slug, /^[a-z-]+$/, slug);
    }
  });
});

describe("t()", () => {
  beforeEach(() => setLang("en"));

  test("substitutes named placeholders", () => {
    assert.match(t("auth.nonPublicMode", { mode: "password" }), /password/);
    assert.doesNotMatch(t("auth.nonPublicMode", { mode: "password" }), /\{mode\}/);
  });

  test("leaves a placeholder untouched when the var is missing", () => {
    assert.match(t("auth.nonPublicMode", {}), /\{mode\}/);
  });

  test("returns the key itself when the key is unknown", () => {
    assert.equal(t("nope.not.a.key"), "nope.not.a.key");
  });

  test("translates the same key differently per language", () => {
    setLang("en");
    const en = t("settings.language");
    setLang("zh-CN");
    assert.notEqual(t("settings.language"), en);
  });
});

describe("setLang", () => {
  test("persists the choice and reports it back", () => {
    setLang("en");
    assert.equal(getLang(), "en");
    assert.equal(JSON.parse(localStorage.getItem("decotv.lang")), "en");
    setLang("zh-CN");
    assert.equal(getLang(), "zh-CN");
    assert.equal(JSON.parse(localStorage.getItem("decotv.lang")), "zh-CN");
  });

  test("ignores an unknown language", () => {
    setLang("zh-CN");
    setLang("fr-FR");
    assert.equal(getLang(), "zh-CN");
  });

  test("nextLang cycles through every language and returns home", () => {
    setLang(LANGS[0]);
    for (let i = 0; i < LANGS.length; i += 1) setLang(nextLang());
    assert.equal(getLang(), LANGS[0]);
  });
});
