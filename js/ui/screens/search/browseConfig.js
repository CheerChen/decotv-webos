// browseConfig.js — static browse filters and tab definitions.
// Each tab carries a Douban config (the default) plus a `tmdb` block that
// describes how the same tab maps to the TMDB sidecar when the user
// switches provider in settings. The search screen reads the active
// provider from a shared store and picks the right branch.

export const YEAR_OPTIONS = [
  { label: "全部", value: "all" },
  { label: "2026", value: "2026" },
  { label: "2025", value: "2025" },
  { label: "2024", value: "2024" },
  { label: "2023", value: "2023" },
  { label: "2022", value: "2022" },
  { label: "2021", value: "2021" },
  { label: "2020", value: "2020" },
  { label: "2020年代", value: "2020年代" },
  { label: "2010年代", value: "2010年代" },
  { label: "2000年代", value: "2000年代" },
  { label: "90年代", value: "90年代" },
  { label: "80年代", value: "80年代" },
  { label: "更早", value: "更早" },
];

export const SORT_OPTIONS = [
  { label: "高分优先", value: "S" },
  { label: "近期热度", value: "U" },
  { label: "首播时间", value: "R" },
  { label: "综合排序", value: "T" },
];

// Movie genres for recommend tab (15 types, all return 23 items).
export const MOVIE_GENRES = [
  { label: "全部", value: "" },
  { label: "剧情", value: "剧情" },
  { label: "喜剧", value: "喜剧" },
  { label: "爱情", value: "爱情" },
  { label: "科幻", value: "科幻" },
  { label: "悬疑", value: "悬疑" },
  { label: "动作", value: "动作" },
  { label: "动画", value: "动画" },
  { label: "奇幻", value: "奇幻" },
  { label: "惊悚", value: "惊悚" },
  { label: "犯罪", value: "犯罪" },
  { label: "战争", value: "战争" },
  { label: "历史", value: "历史" },
  { label: "音乐", value: "音乐" },
  { label: "歌舞", value: "歌舞" },
  { label: "西部", value: "西部" },
];

// TV genres for recommend tab (13 types that return 24 items).
export const TV_GENRES = [
  { label: "全部", value: "" },
  { label: "剧情", value: "剧情" },
  { label: "喜剧", value: "喜剧" },
  { label: "爱情", value: "爱情" },
  { label: "科幻", value: "科幻" },
  { label: "悬疑", value: "悬疑" },
  { label: "动作", value: "动作" },
  { label: "奇幻", value: "奇幻" },
  { label: "惊悚", value: "惊悚" },
  { label: "犯罪", value: "犯罪" },
  { label: "战争", value: "战争" },
  { label: "历史", value: "历史" },
  { label: "音乐", value: "音乐" },
  { label: "歌舞", value: "歌舞" },
];

// Show sub-genres for recommend tab (综艺-specific types).
export const SHOW_GENRES = [
  { label: "全部", value: "" },
  { label: "真人秀", value: "真人秀" },
  { label: "脱口秀", value: "脱口秀" },
  { label: "谈话", value: "谈话" },
];

// Full region list for recommend tabs (10 regions, all return 24 items).
export const REGIONS_FULL = [
  { label: "全部", value: "" },
  { label: "华语", value: "华语" },
  { label: "美国", value: "美国" },
  { label: "日本", value: "日本" },
  { label: "韩国", value: "韩国" },
  { label: "中国香港", value: "中国香港" },
  { label: "中国台湾", value: "中国台湾" },
  { label: "印度", value: "印度" },
  { label: "法国", value: "法国" },
  { label: "英国", value: "英国" },
];

// Anime regions (subset — recommend category=动画 works with these 4).
export const REGIONS_ANIME = [
  { label: "全部", value: "" },
  { label: "日本", value: "日本" },
  { label: "欧美", value: "欧美" },
  { label: "华语", value: "华语" },
];

// Documentary regions (subset for recommend format=纪录片).
export const REGIONS_DOC = [
  { label: "全部", value: "" },
  { label: "华语", value: "华语" },
  { label: "欧美", value: "欧美" },
  { label: "日本", value: "日本" },
  { label: "韩国", value: "韩国" },
];

// Per-tab browse configuration. Each tab maps filter state to one API family.
export const TYPE_CONFIGS = {
  // ── 热门系列 (recent_hot) ──
  "hot-movie": {
    label: "热门电影",
    endpoint: "recent_hot",
    rhKind: "movie",
    filters: [
      {
        id: "category", label: "分类",
        options: [
          { label: "热门电影", value: "热门" },
          { label: "最新电影", value: "最新" },
          { label: "豆瓣高分", value: "豆瓣高分" },
          { label: "冷门佳片", value: "冷门佳片" },
        ],
        default: "热门",
      },
      {
        id: "type", label: "地区",
        options: [
          { label: "全部", value: "全部" },
          { label: "华语", value: "华语" },
          { label: "欧美", value: "欧美" },
          { label: "韩国", value: "韩国" },
          { label: "日本", value: "日本" },
        ],
        default: "全部",
      },
    ],
    tmdb: {
      endpoint: "chart",
      mediaType: "movie",
      filters: [
        {
          id: "chart", label: "榜单",
          options: [
            { label: "周趋势", value: "hot" },
            { label: "正在上映", value: "latest" },
            { label: "高分榜", value: "top_rated" },
            { label: "冷门佳片", value: "hidden_gems" },
          ],
          default: "hot",
        },
      ],
    },
  },
  "hot-tv": {
    label: "热门剧集",
    endpoint: "recent_hot",
    rhKind: "tv",
    rhCategory: "tv",
    filters: [
      {
        id: "type", label: "类型",
        options: [
          { label: "全部", value: "tv" },
          { label: "国产", value: "tv_domestic" },
          { label: "欧美", value: "tv_american" },
          { label: "日本", value: "tv_japanese" },
          { label: "韩国", value: "tv_korean" },
        ],
        default: "tv",
      },
    ],
    tmdb: {
      endpoint: "chart",
      mediaType: "tv",
      filters: [
        {
          id: "chart", label: "榜单",
          options: [
            { label: "周趋势", value: "hot" },
            { label: "今日播出", value: "latest" },
            { label: "高分榜", value: "top_rated" },
            { label: "冷门佳片", value: "hidden_gems" },
          ],
          default: "hot",
        },
      ],
    },
  },
  "hot-anime": {
    label: "热门动漫",
    endpoint: "mixed-anime",
    filters: [
      {
        id: "type", label: "分类",
        options: [
          { label: "全部", value: "tv_animation" },
          { label: "国产", value: "华语" },
          { label: "日本", value: "日本" },
          { label: "欧美", value: "欧美" },
          { label: "每日放送", value: "每日放送" },
        ],
        default: "tv_animation",
      },
    ],
    hasWeekday: true,
    // TMDB has no airing-calendar equivalent; use discover with the
    // animation genre, sorted by popularity. The chart chip becomes a
    // sort selector instead.
    tmdb: {
      endpoint: "discover",
      mediaType: "tv",
      genrePreset: "16",
      // Chinese 动漫 ≈ Japanese animation. 地区=全部 defaults to ja so the
      // tab isn't flooded with US cartoons; picking 日本/欧美/华语 narrows
      // to that country's animation via the language param.
      defaultLanguage: "ja",
      filters: [
        {
          id: "sort", label: "排序",
          options: [
            { label: "热门", value: "popularity" },
            { label: "高分", value: "vote_average" },
            { label: "最新", value: "first_air_date" },
          ],
          default: "popularity",
        },
      ],
    },
  },
  "hot-show": {
    label: "热门综艺",
    endpoint: "recent_hot",
    rhKind: "tv",
    rhCategory: "show",
    filters: [
      {
        id: "type", label: "地区",
        options: [
          { label: "全部", value: "show" },
          { label: "国内", value: "show_domestic" },
          { label: "国外", value: "show_foreign" },
        ],
        default: "show",
      },
    ],
    // TMDB genre 10764 = Reality. Discover with that genre, sorted by
    // popularity. dedupe collapses franchise repeats (Paradise Hotel x3).
    tmdb: {
      endpoint: "discover",
      mediaType: "tv",
      genrePreset: "10764",
      dedupe: true,
      filters: [
        {
          id: "sort", label: "排序",
          options: [
            { label: "热门", value: "popularity" },
            { label: "高分", value: "vote_average" },
            { label: "最新", value: "first_air_date" },
          ],
          default: "popularity",
        },
      ],
    },
  },

  // ── 精选系列 (recommend) ──
  movie: {
    label: "电影",
    endpoint: "recommend",
    recKind: "movie",
    filters: [
      { id: "category", label: "类型", options: MOVIE_GENRES, default: "" },
      { id: "region", label: "地区", options: REGIONS_FULL, default: "" },
      { id: "year", label: "年代", options: YEAR_OPTIONS, default: "all" },
      { id: "sort", label: "排序", options: SORT_OPTIONS, default: "S" },
    ],
    tmdb: {
      endpoint: "discover",
      mediaType: "movie",
      filters: [
        { id: "genre", label: "类型", options: MOVIE_GENRES, default: "" },
        { id: "region", label: "地区", options: REGIONS_FULL, default: "" },
        { id: "year", label: "年代", options: YEAR_OPTIONS, default: "all" },
        { id: "sort", label: "排序", options: SORT_OPTIONS, default: "S" },
      ],
    },
  },
  tv: {
    label: "剧集",
    endpoint: "recommend",
    recKind: "tv",
    recFormat: "电视剧",
    filters: [
      { id: "category", label: "类型", options: TV_GENRES, default: "" },
      { id: "region", label: "地区", options: REGIONS_FULL, default: "" },
      { id: "year", label: "年代", options: YEAR_OPTIONS, default: "all" },
      { id: "sort", label: "排序", options: SORT_OPTIONS, default: "S" },
    ],
    tmdb: {
      endpoint: "discover",
      mediaType: "tv",
      // Douban's 剧集 pool excludes animation (dedicated 动画 category), but
      // TMDB discover mixes genre 16 in — American cartoons AND Japanese
      // anime flood the list. without_genres=16 restores Douban parity; the
      // 动漫 tab covers them with its own genrePreset.
      excludeGenres: "16",
      filters: [
        { id: "genre", label: "类型", options: TV_GENRES, default: "" },
        { id: "region", label: "地区", options: REGIONS_FULL, default: "" },
        { id: "year", label: "年代", options: YEAR_OPTIONS, default: "all" },
        { id: "sort", label: "排序", options: SORT_OPTIONS, default: "S" },
      ],
    },
  },
  anime: {
    label: "动漫",
    endpoint: "recommend",
    recKind: "tv",
    recFormat: "电视剧",
    recCategory: "动画",
    filters: [
      { id: "region", label: "地区", options: REGIONS_ANIME, default: "" },
      { id: "year", label: "年代", options: YEAR_OPTIONS, default: "all" },
      { id: "sort", label: "排序", options: SORT_OPTIONS, default: "S" },
    ],
    tmdb: {
      endpoint: "discover",
      mediaType: "tv",
      genrePreset: "16",
      defaultLanguage: "ja",
      filters: [
        { id: "region", label: "地区", options: REGIONS_ANIME, default: "" },
        { id: "year", label: "年代", options: YEAR_OPTIONS, default: "all" },
        { id: "sort", label: "排序", options: SORT_OPTIONS, default: "S" },
      ],
    },
  },
  show: {
    label: "综艺",
    endpoint: "recommend",
    recKind: "tv",
    recFormat: "综艺",
    filters: [
      { id: "category", label: "类型", options: SHOW_GENRES, default: "" },
      { id: "region", label: "地区", options: REGIONS_FULL, default: "" },
      { id: "year", label: "年代", options: YEAR_OPTIONS, default: "all" },
      { id: "sort", label: "排序", options: SORT_OPTIONS, default: "S" },
    ],
    tmdb: {
      endpoint: "discover",
      mediaType: "tv",
      genrePreset: "10764",
      dedupe: true,
      filters: [
        { id: "region", label: "地区", options: REGIONS_FULL, default: "" },
        { id: "year", label: "年代", options: YEAR_OPTIONS, default: "all" },
        { id: "sort", label: "排序", options: SORT_OPTIONS, default: "S" },
      ],
    },
  },

  // ── 纪录片 (mixed: recent_hot default + recommend curated) ──
  documentary: {
    label: "纪录片",
    endpoint: "mixed",
    filters: [
      {
        id: "mode", label: "分类",
        options: [
          { label: "热门榜单", value: "hot" },
          { label: "精选筛选", value: "curated" },
        ],
        default: "hot",
      },
      { id: "region", label: "地区", options: REGIONS_DOC, default: "", showWhen: "curated" },
      { id: "year", label: "年代", options: YEAR_OPTIONS, default: "all", showWhen: "curated" },
      { id: "sort", label: "排序", options: SORT_OPTIONS, default: "S", showWhen: "curated" },
    ],
    // TMDB genre 99 = Documentary. Chart for the "hot" mode, discover for
    // "curated" — same mode toggle, different backend. dedupe collapses
    // franchise repeats (蠢蛋搞怪秀 x4).
    tmdb: {
      endpoint: "discover",
      mediaType: "movie",
      genrePreset: "99",
      dedupe: true,
      filters: [
        {
          id: "mode", label: "分类",
          options: [
            { label: "热门榜单", value: "hot" },
            { label: "精选筛选", value: "curated" },
          ],
          default: "hot",
        },
        { id: "region", label: "地区", options: REGIONS_DOC, default: "", showWhen: "curated" },
        { id: "year", label: "年代", options: YEAR_OPTIONS, default: "all", showWhen: "curated" },
        { id: "sort", label: "排序", options: SORT_OPTIONS, default: "S", showWhen: "curated" },
      ],
    },
  },
};

// Bangumi weekday labels for hot-anime "每日放送".
export const WEEKDAYS = [
  { value: "Mon", label: "周一" },
  { value: "Tue", label: "周二" },
  { value: "Wed", label: "周三" },
  { value: "Thu", label: "周四" },
  { value: "Fri", label: "周五" },
  { value: "Sat", label: "周六" },
  { value: "Sun", label: "周日" },
];

export function todayWeekday() {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date().getDay()];
}

export function bangumiToCards(calendar, selectedWeekday) {
  const day = calendar.find((entry) => entry.weekday?.en === selectedWeekday);
  return (day?.items || []).map((item) => ({
    title: item.name_cn || item.name,
    poster: item.images?.common || item.images?.medium || item.images?.small || "",
    rate: item.rating?.score ? String(item.rating.score) : "",
    year: item.air_date || "",
    _bangumi: true,
  }));
}
