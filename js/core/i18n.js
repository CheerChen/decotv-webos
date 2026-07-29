// i18n.js — runtime translation for the first-run path (splash / server /
// login / settings) and the error strings those screens display.
//
// Scope is deliberately narrow. Everything the DecoTV server returns — titles,
// summaries, source names, Douban genre and region filters — is Chinese, so
// translating the browse UI would produce English chrome around Chinese
// content without making the app usable to a non-Chinese speaker. What is
// translated is the path that gets someone connected, plus the failures they
// can hit along the way.
//
// Screens re-render from template strings, so there is no data-i18n DOM pass:
// call t() inside the template and re-mount the screen when the language
// changes.

import { LocalStore } from "./storage/localStore.js";

const STORAGE_LANG = "decotv.lang";

export const LANGS = ["zh-CN", "en"];
const FALLBACK = "en";

const DICT = {
  "zh-CN": {
    "lang.self": "中文",
    "html.lang": "zh-CN",

    "splash.connecting": "连接中…",

    "nav.home": "首页",
    "nav.hotMovie": "热门电影",
    "nav.movie": "电影",
    "nav.hotTv": "热门剧集",
    "nav.tv": "剧集",
    "nav.hotAnime": "热门动漫",
    "nav.anime": "动漫",
    "nav.hotShow": "热门综艺",
    "nav.show": "综艺",
    "nav.documentary": "纪录片",
    "nav.library": "收藏",
    "nav.settings": "设置",

    "server.subtitle": "输入服务端地址",
    "server.urlLabel": "服务器 URL",
    "server.connect": "连接",
    "server.emptyUrl": "请输入服务器地址",
    "server.connecting": "连接中…",

    "login.title": "登录",
    "login.subtitle": "登录后收藏与播放记录会和网页端同步",
    "login.username": "用户名",
    "login.password": "密码",
    "login.submit": "登录",
    "login.skip": "仅浏览（跳过）",
    "login.submitting": "登录中…",

    "settings.options": "选项",
    "settings.language": "语言",
    "settings.changeServer": "切换服务器",
    "settings.clearRecords": "清空播放记录",
    "settings.clearedRecords": "已清空播放记录",
    "settings.deviceInfo": "本机信息",
    "settings.appVersion": "应用版本",
    "settings.appId": "应用 ID",
    "settings.serverInfo": "服务器信息",
    "settings.siteName": "站点名称",
    "settings.serverUrl": "服务器地址",
    "settings.serverVersion": "服务端版本",
    "settings.storageType": "存储模式",
    "settings.authMode": "认证模式",

    "auth.unknownMode": "未知",
    "auth.nonPublicMode": "该服务器为「{mode}」模式，本应用仅支持 public（公开）模式的 DecoTV 服务器。请将服务器 AuthMode 设为 public 后重试。",
    "auth.badCredentials": "凭据无效",
    "auth.cannotConnect": "无法连接到服务器",

    "app.unknownError": "未知错误"
  },

  en: {
    "lang.self": "English",
    "html.lang": "en",

    "splash.connecting": "Connecting…",

    // Twelve tabs share one row, so these stay terse: "Hot" rather than
    // "Popular", bare nouns rather than "TV Series" / "Variety Shows". Measured
    // on a 1920x1080 panel the row ends at ~1525px of the 1670px track; a
    // longer wording here is what would push it into a second line.
    "nav.home": "Home",
    "nav.hotMovie": "Hot Movies",
    "nav.movie": "Movies",
    "nav.hotTv": "Hot Series",
    "nav.tv": "Series",
    "nav.hotAnime": "Hot Anime",
    "nav.anime": "Anime",
    "nav.hotShow": "Hot Variety",
    "nav.show": "Variety",
    "nav.documentary": "Documentary",
    "nav.library": "Favorites",
    "nav.settings": "Settings",

    "server.subtitle": "Enter the server address",
    "server.urlLabel": "Server URL",
    "server.connect": "Connect",
    "server.emptyUrl": "Enter a server address",
    "server.connecting": "Connecting…",

    "login.title": "Sign in",
    "login.subtitle": "Signing in syncs favorites and play history with the web client",
    "login.username": "Username",
    "login.password": "Password",
    "login.submit": "Sign in",
    "login.skip": "Browse only (skip)",
    "login.submitting": "Signing in…",

    "settings.options": "Options",
    "settings.language": "Language",
    "settings.changeServer": "Change server",
    "settings.clearRecords": "Clear play history",
    "settings.clearedRecords": "Play history cleared",
    "settings.deviceInfo": "This device",
    "settings.appVersion": "App version",
    "settings.appId": "App ID",
    "settings.serverInfo": "Server",
    "settings.siteName": "Site name",
    "settings.serverUrl": "Server address",
    "settings.serverVersion": "Server version",
    "settings.storageType": "Storage mode",
    "settings.authMode": "Auth mode",

    "auth.unknownMode": "unknown",
    "auth.nonPublicMode": "This server runs in “{mode}” mode. DecoTV for webOS only supports servers in public mode. Set AuthMode to public and try again.",
    "auth.badCredentials": "Invalid credentials",
    "auth.cannotConnect": "Cannot reach the server",

    "app.unknownError": "Unknown error"
  }
};

// The TV's own language decides the default: anything Chinese gets Chinese,
// everything else gets English. A manual pick in settings wins and persists.
export function detectLang(navLang) {
  const tag = String(navLang || "").toLowerCase();
  return tag.startsWith("zh") ? "zh-CN" : "en";
}

let lang = (() => {
  const stored = LocalStore.get(STORAGE_LANG, null);
  if (stored && DICT[stored]) return stored;
  return detectLang(typeof navigator !== "undefined" ? navigator.language : "");
})();

export function getLang() {
  return lang;
}

// Look up a key, falling back to English and then to the key itself so a
// missing string shows up as `settings.authMode` rather than as blank UI.
export function t(key, vars) {
  const table = DICT[lang] || DICT[FALLBACK];
  const value = table[key] ?? DICT[FALLBACK][key] ?? key;
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
  );
}

export function setLang(next) {
  if (!DICT[next] || next === lang) return;
  lang = next;
  LocalStore.set(STORAGE_LANG, lang);
  applyDocumentLang();
}

// The language the UI would switch to next. With two languages this is just
// "the other one"; kept as a cycle so adding a third needs no caller changes.
export function nextLang() {
  return LANGS[(LANGS.indexOf(lang) + 1) % LANGS.length];
}

export function applyDocumentLang() {
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.setAttribute("lang", t("html.lang"));
  }
}
