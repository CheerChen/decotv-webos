// tests/e2e/fixtures/data.mjs — deterministic fake catalog for the e2e suite.

export const SERVER_CONFIG = {
  SiteName: "DecoTV-E2E",
  // StorageType "localstorage" enables anonymous browsing (canBrowseAnonymously),
  // so boot needs only POST /api/login to return 200 — no credentials, no verify.
  StorageType: "localstorage",
  AuthMode: "public",
  Version: "0.0.0-e2e",
};

const MEDIA = (n) => `http://127.0.0.1:4173/tests/e2e/assets/ep${n}.webm`;
// URLs without a media extension force the player through /api/playback/resolve.
const OPAQUE = (src, n) => `http://127.0.0.1:4173/e2e-opaque/${src}/ep${n}`;

// ---- Title 1: 测试剧集 — happy path, 3 sources, s1 wins ----
const SHOW_A = ["s1", "s2", "s3"].map((source, i) => ({
  id: String((i + 1) * 100 + 1), // s1 -> "101", s2 -> "201", s3 -> "301"
  source,
  source_name: ["源一", "源二", "源三"][i],
  title: "测试剧集",
  year: "2024",
  type_name: "电视剧",
  desc: "e2e mock",
  poster: "https://poster.example/a.jpg",
  episodes: [MEDIA(1), MEDIA(2), MEDIA(3)],
}));

// ---- Title 2: 故障剧 — failover path, best source's resolve 500s ----
const SHOW_B = [
  {
    id: "901", source: "f1", source_name: "坏源", title: "故障剧", year: "2023",
    type_name: "电视剧", desc: "e2e mock", poster: "https://poster.example/b.jpg",
    episodes: [OPAQUE("f1", 1), OPAQUE("f1", 2)],
  },
  {
    id: "902", source: "f2", source_name: "好源", title: "故障剧", year: "2023",
    type_name: "电视剧", desc: "e2e mock", poster: "https://poster.example/b.jpg",
    episodes: [MEDIA(1), MEDIA(2)],
  },
];

export const CATALOG = [...SHOW_A, ...SHOW_B];

// Probe results keyed by `source` query param. Shapes mirror /api/playback/probe.
// s1/f1: verified 1080p -> hits PREFER_QUALITY_SHORTCUT_RANK, autoplay fires
// immediately and deterministically picks them (quality outranks the rest).
export const PROBES = {
  s1: { status: "ok", playable: true, quality: "1080p", speedKBps: 5000, pingTime: 20, startupTimeMs: 300, mediaType: "media" },
  s2: { status: "ok", playable: true, quality: "720p", speedKBps: 3000, pingTime: 40, startupTimeMs: 500, mediaType: "media" },
  s3: { hasError: true, status: "failed", failureKind: "network", message: "mock network failure" },
  f1: { status: "ok", playable: true, quality: "1080p", speedKBps: 6000, pingTime: 15, startupTimeMs: 200, mediaType: "media" },
  f2: { status: "ok", playable: true, quality: "720p", speedKBps: 2500, pingTime: 50, startupTimeMs: 600, mediaType: "media" },
};

export const RESOLVE_FAILS = new Set(["f1"]);

// Home 热门电影 chart (row 0). Home cards pass title (no year) to detail.
export const HOME_MOVIE_CARDS = [
  { id: "d1", title: "测试剧集", poster: "https://poster.example/a.jpg", rate: "8.5", year: "2024" },
  { id: "d2", title: "故障剧", poster: "https://poster.example/b.jpg", rate: "7.0", year: "2023" },
];
