// Live validation of doubanDirect's URL building + filtering against the
// real rexxar API. Not part of `npm test` (network dependent); run by hand:
//   node scripts/douban-direct-live.mjs
import { buildRecommendPath, mapRexxarItem, pickVoteFloor } from "../js/core/network/doubanDirect.js";

const POOL_CHUNK = 100;
const POOL_CHUNKS = 5;
const PAGE = 20;

async function fetchChunk(kind, opts, start) {
  const url = "https://m.douban.com" + buildRecommendPath(kind, opts, start, POOL_CHUNK);
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      "Referer": "https://m.douban.com/explore"
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.items)) throw new Error("bad shape");
  return data.items;
}

// Mirrors RecommendPaginator.fetchPool: one parallel round of fixed chunks.
async function fetchPool(kind, opts) {
  const t0 = Date.now();
  const chunks = await Promise.all(
    Array.from({ length: POOL_CHUNKS }, (_, i) => fetchChunk(kind, opts, i * POOL_CHUNK)));
  const items = chunks.flat()
    .filter((i) => i && (i.type === "movie" || i.type === "tv"))
    .map(mapRexxarItem);
  return { items, sizes: chunks.map((c) => c.length), ms: Date.now() - t0 };
}

async function browse(label, kind, opts) {
  console.log(`\n=== ${label} ===`);
  const { items, sizes, ms } = await fetchPool(kind, opts);
  const unique = new Set(items.map((i) => i.id)).size;
  const floor = pickVoteFloor(items, PAGE);
  const kept = items.filter((i) => i.votes >= floor);
  console.log(`1 round (chunks ${sizes.join("/")}) in ${ms} ms: pool ${items.length} (${unique} unique), floor ${floor} → ${kept.length} kept`);
  for (const item of kept.slice(0, 5)) {
    console.log(`  ${item.rate}  ${String(item.votes).padStart(8)}  ${item.title}`);
  }
  if (kept.length > 5) console.log(`  … +${kept.length - 5} more`);
}

await browse("华语 电影 高分优先 (sort=S)", "movie", { region: "华语", sort: "S" });
await browse("美国 电影 高分优先 (sort=S)", "movie", { region: "美国", sort: "S" });
await browse("日本 2025 电影 高分优先 (narrow: floor loosens)", "movie", { region: "日本", year: "2025", sort: "S" });
await browse("华语×歌舞×90年代 (starvation path)", "movie", { region: "华语", category: "歌舞", year: "90年代", sort: "S" });
