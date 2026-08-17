// Live validation of doubanDirect's URL building + filtering against the
// real rexxar API. Not part of `npm test` (network dependent); run by hand:
//   node scripts/douban-direct-live.mjs
import { buildRecommendPath, mapRexxarItem } from "../js/core/network/doubanDirect.js";

const UPSTREAM_BATCH = 60;
const PAGE = 20;
const VOTE_FLOOR_STEPS = [10000, 3000, 1000];
const HUNGRY_STEP_THRESHOLD = 2;

async function fetchUpstream(path) {
  const url = "https://m.douban.com" + path;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      "Referer": "https://m.douban.com/explore"
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.items)) throw new Error("bad shape");
  return data.items
    .filter((i) => i && (i.type === "movie" || i.type === "tv"))
    .map(mapRexxarItem);
}

async function browse(label, kind, opts) {
  console.log(`\n=== ${label} ===`);
  let floorIndex = 0, hungry = 0, exhausted = false;
  const seen = new Set();
  let buffer = [], upstreamStart = 0;
  const pages = [];
  for (let p = 0; p < 5 && !exhausted; p++) {
    while (buffer.length < PAGE && !exhausted) {
      const path = buildRecommendPath(kind, opts, upstreamStart, UPSTREAM_BATCH);
      const batch = await fetchUpstream(path);
      if (batch.length === 0) exhausted = true;
      upstreamStart += batch.length;
      const floor = VOTE_FLOOR_STEPS[floorIndex];
      const survivors = [];
      for (const item of batch) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        if (item.votes >= floor) survivors.push(item);
      }
      if (survivors.length === 0 && batch.length > 0) {
        hungry += 1;
        if (hungry >= HUNGRY_STEP_THRESHOLD && floorIndex < VOTE_FLOOR_STEPS.length - 1) {
          floorIndex += 1; hungry = 0;
          console.log(`  [floor stepped down → ${VOTE_FLOOR_STEPS[floorIndex]}]`);
        }
      } else hungry = 0;
      buffer = buffer.concat(survivors);
    }
    const page = buffer.slice(0, PAGE);
    buffer = buffer.slice(PAGE);
    pages.push(page);
    console.log(`page ${p + 1}: ${page.length} items (floor ${VOTE_FLOOR_STEPS[floorIndex]})`);
    for (const item of page.slice(0, 5)) {
      console.log(`  ${item.rate}  ${String(item.votes).padStart(8)}  ${item.title}`);
    }
    if (page.length > 5) console.log(`  … +${page.length - 5} more`);
  }
  const all = pages.flat();
  const concertish = all.filter((i) => /演唱会|演唱會|音乐会|音樂會|LIVE|Live/i.test(i.title + " " + i.subtitle));
  console.log(`total ${all.length} items, concert-ish (title/subtitle heuristic, NOT the filter): ${concertish.length}`);
  for (const c of concertish) console.log(`  !! ${c.rate} ${c.votes} ${c.title}`);
}

await browse("华语 电影 高分优先 (sort=S)", "movie", { region: "华语", sort: "S" });
await browse("美国 电影 高分优先 (sort=S)", "movie", { region: "美国", sort: "S" });
await browse("华语×歌舞×90年代 (starvation path)", "movie", { region: "华语", category: "歌舞", year: "90年代", sort: "S" });
