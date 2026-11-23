// Resolve valid thinking levels per model — drives UI level picker (suffix "model(level)").
// Reuses capabilities.js (thinkingFormat/canDisable) so this file only maps format→levels (DRY).
import { getCapabilitiesForModel } from "./capabilities.js";
import { matchPattern } from "./pricing.js";
import { resolveKiroEffortPath } from "../config/kiroConstants.js";
import { getProviderModels } from "../config/providerModels.js";

// Shared level sets (deduped) — verified against provider docs + wire in thinkingUnified.applyFormat.
const L = {
  base: ["none", "low", "medium", "high"],                          // qwen, step, hunyuan, gemini-budget
  onOff: ["none", "thinking"],                                      // zai (binary), minimax (adaptive)
  openai: ["none", "minimal", "low", "medium", "high", "xhigh"],    // GPT-5.x / o-series (no "max")
  levelMax: ["none", "low", "medium", "high", "max"],               // kimi
  budgetX: ["none", "low", "medium", "high", "xhigh", "max"],       // claude-budget, claude-adaptive
  gemini: ["minimal", "low", "medium", "high"],                     // gemini-3 thinkingLevel (no disable)
  hiMax: ["none", "high", "max"],                                   // deepseek (low/med→high, xhigh→max)
};

// thinkingFormat → valid selectable levels (source of truth for UI options).
const FORMAT_LEVELS = {
  openai: L.openai,
  "claude-adaptive": L.budgetX,
  "claude-budget": L.budgetX,
  "gemini-level": L.gemini,
  "gemini-budget": L.base,
  zai: L.onOff,
  qwen: L.base,
  kimi: L.levelMax,
  deepseek: L.hiMax,
  commandcode: ["none", "low", "medium", "high", "xhigh", "max"],
  minimax: L.onOff,
  hunyuan: L.base,
  step: L.base,
  nous: L.base,
};

const CODEX_GPT_5_6_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

// Opus/Sonnet 4.6 lack xhigh (Anthropic + Kiro docs) — keep the 4-level+max set.
const CLAUDE_NO_XHIGH = ["none", "low", "medium", "high", "max"];

// Model-name pattern overrides (glob, first match wins) — more precise than format default.
const PATTERN_THINKING = [
  // Gemini 4 (Argon) rejects "minimal" with 400 — LOW is the floor; cannot disable thinking.
  // Gemini 4 Neon adds an xhigh tier on top of Argon's set; still no "minimal".
  { pattern: "*gemini-4-neon*", levels: ["low", "medium", "high", "xhigh"] },
  { pattern: "*gemini-4*", levels: ["low", "medium", "high"] },
  { pattern: "*claude*4.6*", levels: CLAUDE_NO_XHIGH },
  { pattern: "*claude*4-6*", levels: CLAUDE_NO_XHIGH },
  { provider: "codex", pattern: "*gpt-6*", levels: CODEX_GPT_5_6_LEVELS },
  { provider: "codex", pattern: "*gpt-5.6-sol*", levels: [...CODEX_GPT_5_6_LEVELS, "ultra"] },
  { provider: "codex", pattern: "*gpt-5.6-terra*", levels: [...CODEX_GPT_5_6_LEVELS, "ultra"] },
  { provider: "codex", pattern: "*gpt-5.6-luna*", levels: CODEX_GPT_5_6_LEVELS },
  { pattern: "*codex*", levels: ["low", "medium", "high", "xhigh"] }, // codex cannot disable thinking
  // OpenCode Free (oc) MiMo rides the same OpenRouter-backed route as the rest of
  // that lane and takes the full OpenAI effort enum verbatim (probed live: all
  // seven values 200, anything else 400 "Invalid option"), so it owns the entry
  // ahead of the unqualified *mimo*v2.6* one below — that one describes Xiaomi's
  // own API, and its [none..xhigh] set would make max unreachable here (the
  // deepseek wire branch clamps max→high when the declared set lacks it).
  { provider: "opencode", pattern: "*mimo*v2.6*", levels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
  { pattern: "*mimo*v2.6*", levels: ["none", "low", "medium", "high", "xhigh"] },
  // mimo-v2.5-pro on opencode-go rejects reasoning_effort "max" (probed live); v2.5 accepts it.
  { pattern: "*mimo*v2.5-pro*", levels: ["none", "low", "medium", "high", "xhigh"] },
  // DeepSeek v4.* (Alibaba MaaS, probed live): effort low|medium|high|xhigh|max
  // all 200 via output_config.effort; "none" is a 400 on the anthropic route
  // (disable thinking instead). none kept for the picker = disable.
  // ⚠️ The codebuddy-cn exact ids below MUST stay above this unqualified glob —
  // PATTERN_THINKING is first-match-wins, so a later provider-qualified entry
  // would never fire for dotted ids like deepseek-v4.1-flash.
  { provider: "codebuddy-cn", pattern: "deepseek-v4-pro",     levels: ["low", "high", "xhigh"] },
  { provider: "codebuddy-cn", pattern: "deepseek-v4.1-flash", levels: ["low", "high", "max"] },
  // OpenCode Zen free tier (oc / ocz) — the free id of the same v4.1-flash model
  // publishes low|high|max as well, and unlike DeepSeek's own API the upstream
  // forwards the level verbatim (no low→high collapse). The generic
  // *deepseek-v4.* glob below would advertise medium/xhigh, which the model does
  // not serve, so this entry MUST stay above it.
  { pattern: "*deepseek-v4.1-flash-free*", levels: ["low", "high", "max"] },
  { pattern: "*deepseek-v4.*", levels: ["none", "low", "medium", "high", "xhigh", "max"] },
  // codebuddy-cn per-model effort sets — the server's product-config payload
  // publishes `reasoning.supportedEfforts` per model. NOTE: the chat endpoint
  // accepts any level you send (probed none/minimal/low/medium/high/xhigh/max
  // → all 200), but values outside a model's supportedEfforts are silently
  // clamped, so the declared set stays authoritative for the picker. Models
  // that publish no supportedEfforts (glm-5.1 / kimi-k3-1 / minimax-m3)
  // fall through to the openai format default.
  { provider: "codebuddy-cn", pattern: "glm-5.3",      levels: ["low", "high", "max"] },
  { provider: "codebuddy-cn", pattern: "glm-5.3-flash", levels: ["low", "high", "max"] },
  { provider: "codebuddy-cn", pattern: "glm-5.2",      levels: ["high", "xhigh"] },
  { provider: "codebuddy-cn", pattern: "kimi-k2.8-preview",  levels: ["low", "medium", "high"] },
  { provider: "codebuddy-cn", pattern: "hy3",          levels: ["low", "high"] },
  { provider: "codebuddy-cn", pattern: "hy4-preview",  levels: ["high"] },
  // codebuddy-intl rides the same gateway catalog, so its deepseek levels match.
  { provider: "codebuddy-intl", pattern: "deepseek-v4*", levels: ["low", "high", "xhigh"] },
  // MiniMax Code (mcode) — adaptive effort via output_config.effort. M3.1
  // always thinks (no none); M3 is switchable with none/high only, per the
  // magpie static catalog. M2.7 pair falls through to the claude-adaptive
  // set minus none (canDisable: false).
  { provider: "minimax-code", pattern: "MiniMax-M3.1*", levels: ["low", "medium", "high", "xhigh", "max"] },
  { provider: "minimax-code", pattern: "MiniMax-M3", levels: ["none", "high"] },
  { provider: "minimax-code-global", pattern: "MiniMax-M3.1*", levels: ["low", "medium", "high", "xhigh", "max"] },
  { provider: "minimax-code-global", pattern: "MiniMax-M3", levels: ["none", "high"] },
];

// OpenAI documents reasoning.effort "max" for GPT-5.6 and GPT-6 (#5186). The codex rows
// above already carry it; an OpenAI Compatible node serving the same ids gets the same
// set, otherwise the "openai" format list (no max) clamps max to xhigh on the wire.
const OPENAI_MAX_EFFORT_MODEL = /(?:^|\/)gpt-(?:5\.6|6)(?:[.-]|$)/i;
const isOpenAICompatibleNode = (provider) => String(provider || "").startsWith("openai-compatible-");

// Canonical ordering for intersecting thinking levels across combo seats.
const CANONICAL_LEVEL_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "thinking"];
const MAX_COMBO_DEPTH = 6;

// Returns valid thinking levels for a model, or null when the model has no reasoning.
export function getThinkingLevels(provider, model) {
  if (provider === "kiro" && resolveKiroEffortPath(model) === null) return null;
  const caps = getCapabilitiesForModel(provider, model);
  if (!caps.reasoning) return null;
  const baseId = String(model || "").replace(/\([^()]+\)\s*$/, "");
  const modelLevels = provider === "codex"
    ? getProviderModels("cx").find((entry) => entry.id === baseId)?.thinkingLevels
    : null;
  const hit = PATTERN_THINKING.find((entry) =>
    (!entry.provider || entry.provider === provider) && matchPattern(entry.pattern, model)
  );
  let levels = modelLevels || hit?.levels
    || (isOpenAICompatibleNode(provider) && OPENAI_MAX_EFFORT_MODEL.test(baseId) ? CODEX_GPT_5_6_LEVELS : null)
    || FORMAT_LEVELS[caps.thinkingFormat] || L.base;
  if (caps.thinkingCanDisable === false) levels = levels.filter((l) => l !== "none");
  return levels;
}

/**
 * Aggregate valid thinking levels for a combo from its seats.
 *
 * A combo with fallback may route any request to any seat, so only levels
 * accepted by EVERY seat are advertised (intersection, kept in canonical
 * order). Returns null if the combo is empty, any seat lacks reasoning, the
 * intersection is empty, or a cycle/depth limit is hit with no valid seats.
 *
 * @param {string[]} comboModels - Seat strings ("alias/model" or nested combo names)
 * @param {Object|null} [comboLookup] - Optional map of combo name -> models array
 * @param {Function|null} [resolveLevels] - Optional (seat) => string[]|null resolver (e.g. UI alias -> providerId)
 * @param {Set<string>} [_visiting] - Internal cycle guard
 * @param {number} [_depth] - Internal recursion depth guard
 * @returns {string[]|null}
 */
export function aggregateComboThinkingLevels(
  comboModels,
  comboLookup = null,
  resolveLevels = null,
  _visiting = new Set(),
  _depth = 0,
) {
  if (!Array.isArray(comboModels) || comboModels.length === 0 || _depth > MAX_COMBO_DEPTH) return null;

  let common = null;
  for (const seat of comboModels) {
    if (typeof seat !== "string" || !seat) continue;
    let seatLevels = null;
    const slash = seat.indexOf("/");
    if (slash <= 0 && comboLookup?.[seat]) {
      if (_visiting.has(seat)) return null;
      _visiting.add(seat);
      try {
        seatLevels = aggregateComboThinkingLevels(comboLookup[seat], comboLookup, resolveLevels, _visiting, _depth + 1);
      } finally {
        _visiting.delete(seat);
      }
    } else if (resolveLevels) {
      seatLevels = resolveLevels(seat);
    } else {
      const provider = slash <= 0 ? null : seat.slice(0, slash);
      const model = slash <= 0 ? seat : seat.slice(slash + 1);
      seatLevels = getThinkingLevels(provider, model);
    }

    if (!Array.isArray(seatLevels) || seatLevels.length === 0) return null;
    const seatSet = new Set(seatLevels);
    common = common === null
      ? seatSet
      : new Set([...common].filter((level) => seatSet.has(level)));
    if (common.size === 0) return null;
  }

  if (!common || common.size === 0) return null;
  const orderIndex = (level) => {
    const idx = CANONICAL_LEVEL_ORDER.indexOf(level);
    return idx === -1 ? CANONICAL_LEVEL_ORDER.length : idx;
  };
  return [...common].sort((a, b) => orderIndex(a) - orderIndex(b));
}
