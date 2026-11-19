import { priceKey } from "open-sse/providers/catalogOverride.js";

// Turns the models.dev catalog into the price table the router bills with.
//
// models.dev lists the same model under many gateways at different prices, so a model id alone is
// ambiguous. Resolution order for a (provider, model) request:
//   1. the gateway the request used, when models.dev lists it under that name (claude -> anthropic)
//   2. the model's own vendor (anthropic, openai, google ...), the price a direct API customer pays
//   3. the non-zero price at least two gateways agree on (a single unknown gateway is not a price list)
// A vendor listing at $0 does not count as a price: gateways that give a model away list it that way.
// The file keeps (1) per provider+model and (2)/(3) per model, so the reader is two lookups.

// 9router provider id -> models.dev provider id, for gateways that carry the vendor's own prices.
export const PRICE_PROVIDER_ALIASES = {
  claude: "anthropic",
  gemini: "google",
  codex: "openai",
  github: "github-copilot",
  glm: "zai",
  "glm-cn": "zhipuai",
  zhipu: "zhipuai",
  kimi: "moonshotai",
  "kimi-cn": "moonshotai-cn",
  qwen: "alibaba",
  "qwen-cn": "alibaba-cn",
  hunyuan: "tencent",
  doubao: "volcengine",
  "cloudflare-ai": "cloudflare-workers-ai",
};

// Vendors that sell their own models: their list price is "the API price".
const VENDORS = ["anthropic", "openai", "google", "xai", "deepseek", "zai", "moonshotai", "meta", "minimax", "alibaba", "mistral", "cohere", "perplexity"];

const num = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : 0);

// models.dev cost -> router pricing ($ per 1M tokens). A missing cache price is left at 0 and the
// cost function charges the input rate for it, which is what a gateway without caching does.
export function toPricing(cost) {
  if (!cost || !(Number(cost.input) >= 0) || !(Number(cost.output) >= 0) || cost.input === undefined) return null;
  const p = {
    input: num(cost.input),
    output: num(cost.output),
    cached: num(cost.cache_read),
    cache_creation: num(cost.cache_write),
    reasoning: num(cost.reasoning) || num(cost.output),
  };
  // Prices that apply once the prompt is longer than `size` tokens (long-context surcharge).
  const tiers = (cost.tiers || [])
    .filter((t) => t?.tier?.type === "context" && Number(t.tier.size) > 0)
    .map((t) => ({
      size: Number(t.tier.size),
      input: num(t.input), output: num(t.output), cached: num(t.cache_read), cache_creation: num(t.cache_write),
    }))
    .sort((a, b) => a.size - b.size);
  if (tiers.length) p.tiers = tiers;
  return p;
}

const sig = (p) => JSON.stringify([p.input, p.output, p.cached, p.cache_creation, p.tiers || null]);

export function build(catalog) {
  const byProvider = {};
  const perModel = new Map(); // id -> [{ provider, pricing }]
  for (const [providerId, provider] of Object.entries(catalog || {})) {
    for (const [modelId, model] of Object.entries(provider?.models || {})) {
      const pricing = toPricing(model?.cost);
      if (!pricing) continue;
      const id = priceKey(modelId);
      // Several upstream ids can normalise to one (":free" variants): the first, listed one wins.
      if (!byProvider[`${providerId}:${id}`]) byProvider[`${providerId}:${id}`] = pricing;
      if (!perModel.has(id)) perModel.set(id, []);
      perModel.get(id).push({ provider: providerId, pricing });
    }
  }

  const byModel = {};
  const isPaid = (p) => p.input > 0 || p.output > 0;
  for (const [id, list] of perModel) {
    const vendor = VENDORS.map((v) => list.find((e) => e.provider === v)).find((e) => e && isPaid(e.pricing));
    if (vendor) { byModel[id] = vendor.pricing; continue; }
    const votes = new Map();
    for (const e of list.filter((e) => isPaid(e.pricing))) {
      const k = sig(e.pricing);
      if (!votes.has(k)) votes.set(k, { n: 0, pricing: e.pricing });
      votes.get(k).n++;
    }
    const best = [...votes.values()].sort((a, b) => b.n - a.n || a.pricing.input - b.pricing.input)[0];
    if (best && best.n >= 2) { byModel[id] = best.pricing; continue; }
    // Free everywhere it is listed: record the $0 so it is not priced from the old tables.
    if (!list.some((e) => isPaid(e.pricing))) byModel[id] = list[0].pricing;
  }

  // File the per-gateway prices under the router's own provider ids as well.
  for (const [local, upstream] of Object.entries(PRICE_PROVIDER_ALIASES)) {
    const prefix = `${upstream}:`;
    for (const key of Object.keys(byProvider)) {
      if (key.startsWith(prefix)) byProvider[`${local}:${key.slice(prefix.length)}`] = byProvider[key];
    }
  }
  return { byProvider, byModel };
}
