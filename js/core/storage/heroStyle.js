// heroStyle.js — how the details page's hero shows a work.
//   "poster"   portrait cover beside the info (default, the original look)
//   "backdrop" a landscape still behind the info when the work's provider
//              has one (TMDB backdrop, a douban photo-wall frame); works
//              without one keep the poster
import { LocalStore } from "./localStore.js";

const STORAGE_KEY = "decotv.detailHero";

export function getHeroStyle() {
  return LocalStore.get(STORAGE_KEY, null) === "backdrop" ? "backdrop" : "poster";
}

export function setHeroStyle(style) {
  const value = style === "backdrop" ? "backdrop" : "poster";
  LocalStore.set(STORAGE_KEY, value);
  return value;
}
