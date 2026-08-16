// catalogProvider.js — global catalog provider switch.
// The browse tabs stay the same regardless of provider; this stores which
// backend ("douban" | "tmdb") feeds them. Douban is the default and needs
// no sidecar; TMDB requires a sidecar URL (see tmdbClient.js).

import { LocalStore } from "./localStore.js";

const STORAGE_KEY = "decotv.catalogProvider";
const DEFAULT_PROVIDER = "douban";

export function getProvider() {
  const stored = LocalStore.get(STORAGE_KEY, null);
  return stored === "tmdb" ? "tmdb" : DEFAULT_PROVIDER;
}

export function setProvider(provider) {
  const value = provider === "tmdb" ? "tmdb" : "douban";
  LocalStore.set(STORAGE_KEY, value);
  return value;
}

export function toggleProvider() {
  return setProvider(getProvider() === "tmdb" ? "douban" : "tmdb");
}

export { STORAGE_KEY };
