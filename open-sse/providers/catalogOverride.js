// Read side of the model catalog synced from models.dev.
//
// The file is the source of truth; the only thing held in memory is a parsed
// copy dropped as soon as the file's mtime changes. getCapabilitiesForModel is
// synchronous and runs per request, so the hot path is one stat (~1us) and the
// parse (~0.1ms on a ~18KB file) only reruns after a sync.

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";

export const CATALOG_FILE = path.join(DATA_DIR, "model-catalog.json");
// Trimmed upstream catalog, read by the add-models skill (not by the router).
export const CATALOG_RAW_FILE = path.join(DATA_DIR, "model-catalog-raw.json");
// What each model costs per million tokens, built from the same download (see modelCatalog/prices.js).
export const PRICES_FILE = path.join(DATA_DIR, "model-prices.json");

// Schema of the file this module reads. The writer stamps it; a file carrying an
// older value predates provider-scoped modality keys, and its flat keys are not
// looked up here, so the sync rebuilds it instead of asking upstream for a 304.
export const CATALOG_VERSION = 3;

const EMPTY = { models: {}, providers: {} };
let cache = EMPTY;
let cachedMtime = -1;

// "zai-org/GLM-4.6V:free" -> "glm-4.6v"
function baseId(model) {
  if (!model) return "";
  const withoutVendor = model.includes("/") ? model.split("/").pop() : model;
  return withoutVendor.toLowerCase().split(":")[0];
}

function load() {
  let mtime;
  try {
    mtime = fs.statSync(CATALOG_FILE).mtimeMs;
  } catch {
    cache = EMPTY;
    cachedMtime = -1;
    return cache;
  }
  if (mtime === cachedMtime) return cache;

  cachedMtime = mtime;
  try {
    const parsed = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
    cache = { models: parsed?.models || {}, providers: parsed?.providers || {} };
  } catch {
    cache = EMPTY;
  }
  return cache;
}

// Modalities are recorded per gateway upstream, and gateways disagree about the
// same weights — some do not proxy images at all — so the key is provider +
// model, in the local provider id space, exactly like the limits below. Keying
// by model id alone made short ids collide across vendors: "auto", "free" and
// "efficient" are router modes in one catalog and model names in another, and a
// request to the router mode inherited a stranger's vision.
export function getCatalogModalities(provider, model) {
  if (!provider) return null;
  return load().models[`${provider}:${baseId(model)}`] || null;
}

// Context and output limits are a property of the gateway too: each one
// truncates differently, so these stay keyed by provider + model.
export function getCatalogLimits(provider, model) {
  const byProvider = provider && load().providers[provider];
  if (!byProvider) return null;
  return byProvider[model] || byProvider[baseId(model)] || null;
}

// Prices: one stat per lookup, parsed again only when the file changes, like the capabilities above.
let priceCache = { byProvider: {}, byModel: {} };
let priceMtime = -1;

function loadPrices() {
  let mtime;
  try {
    mtime = fs.statSync(PRICES_FILE).mtimeMs;
  } catch {
    priceCache = { byProvider: {}, byModel: {} };
    priceMtime = -1;
    return priceCache;
  }
  if (mtime === priceMtime) return priceCache;
  priceMtime = mtime;
  try {
    const parsed = JSON.parse(fs.readFileSync(PRICES_FILE, "utf8"));
    priceCache = { byProvider: parsed?.byProvider || {}, byModel: parsed?.byModel || {} };
  } catch {
    priceCache = { byProvider: {}, byModel: {} };
  }
  return priceCache;
}

// Same key as the writer: vendor prefix, ":free" and "(medium)" suffixes dropped, lower-cased.
export function priceKey(model) {
  if (!model) return "";
  const base = String(model).includes("/") ? String(model).split("/").pop() : String(model);
  return base.replace(/\((?:minimal|low|medium|high|xhigh|max)\)$/i, "").toLowerCase().split(":")[0].trim();
}

// Price the gateway itself lists, else the model vendor's, else the most common reseller price.
export function getCatalogPricing(provider, model) {
  const key = priceKey(model);
  if (!key) return null;
  const { byProvider, byModel } = loadPrices();
  return (provider && byProvider[`${provider}:${key}`]) || byModel[key] || null;
}

// Force a re-read on the next lookup (called right after a sync writes the file).
export function invalidateCatalog() {
  cachedMtime = -1;
  priceMtime = -1;
}

// Hand the reader to capabilities.js. That module is bundled into the browser
// too, so it cannot import this file directly — the server pushes it in.
export async function installCatalogSource() {
  const { setCatalogSource } = await import("./capabilities.js");
  setCatalogSource({ getModalities: getCatalogModalities, getLimits: getCatalogLimits });
  const { setPriceSource } = await import("./pricing.js");
  setPriceSource({ getPricing: getCatalogPricing });
}
