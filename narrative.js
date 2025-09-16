import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function loadNarrative(jsonPath) {
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  const full = path.resolve(baseDir, jsonPath);
  const raw = await fs.readFile(full, "utf8");
  const data = JSON.parse(raw);
  const buckets = {};
  for (const [k, v] of Object.entries(data || {})) {
    buckets[k] = Array.isArray(v) ? v.slice() : [];
  }
  return buckets;
}

function pick(arr, weights = null) {
  if (!arr || arr.length === 0) return "";
  if (!weights) return arr[(Math.random() * arr.length) | 0];
  let sum = 0;
  const cum = weights.map(w => (sum += Math.max(0, w)));
  if (sum <= 0) return arr[(Math.random() * arr.length) | 0];
  const r = Math.random() * sum;
  const idx = cum.findIndex(x => x >= r);
  return arr[Math.max(0, idx)];
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function fmtPct(x) {
  if (!isFinite(x)) return "0.0%";
  return `${x.toFixed(1)}%`;
}
function fmtAmount(x, unit = "") {
  if (!isFinite(x)) return unit ? `0 ${unit}` : "0";
  const ax = Math.abs(x);
  let val = x;
  let suffix = "";
  if (ax >= 1e9) { val = x / 1e9; suffix = "B"; }
  else if (ax >= 1e6) { val = x / 1e6; suffix = "M"; }
  else if (ax >= 1e3) { val = x / 1e3; suffix = "k"; }
  return unit ? `${val.toFixed(val >= 10 ? 0 : 1)}${suffix} ${unit}` : `${val.toFixed(val >= 10 ? 0 : 1)}${suffix}`;
}
function fmtPrice(x, ccy = "") {
  if (!isFinite(x)) return ccy ? `${ccy}0` : "0";
  const s = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(2) : x.toFixed(3);
  return ccy ? `${ccy}${s}` : s;
}
function fmtIndex(x) {
  if (!isFinite(x)) return "1000";
  return x >= 100 ? x.toFixed(0) : x.toFixed(1);
}

function regimeList(world) {
  const regs = world?.regimes || [];
  return regs.map((R, i) => (R?.name || `R${i}`));
}
function randomDistinctIndices(n, k) {
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, Math.min(k, n));
}
function pickRegimeNames(world, howMany) {
  const names = regimeList(world);
  if (names.length === 0) return Array(howMany).fill("Unknown");
  const k = randomDistinctIndices(names.length, howMany).map(i => names[i]);
  while (k.length < howMany) k.push(names[0]);
  return k;
}
function pickRival(world, avoid = []) {
  const names = regimeList(world).filter(n => !avoid.includes(n));
  if (!names.length) return "Rival";
  return names[(Math.random() * names.length) | 0];
}
function pickMarket(world) {
  const guesses = ["Metals", "Energy", "Housing", "Food", "FX", "Debt", "Equities"];
  const m = world?.markets;
  if (m && typeof m === "object") {
    const keys = Object.keys(m);
    if (keys.length) return keys[(Math.random() * keys.length) | 0];
  }
  return guesses[(Math.random() * guesses.length) | 0];
}
function pickCommodity(world) {
  const list = ["crude", "diesel", "LNG", "wheat", "maize", "rice", "copper", "nickel", "lithium", "gold"];
  return list[(Math.random() * list.length) | 0];
}

function bucketWeightsFor(label, NARR, world) {
  const pol = (world?.globals?.difficulty || world?.difficulty || "").toString().toUpperCase();
  const isMAX = pol === "MAX";
  const base = Object.fromEntries(Object.keys(NARR).map(k => [k, 1]));
  const phaseBias = {
    globals: ["globals", "finance", "liquidity", "generic"],
    local_markets: ["local_markets", "rally", "crash", "generic"],
    trade: ["trade", "currency", "sanctions", "generic"],
    diplomacy: ["diplomacy", "alliances", "conflict"],
    alliances: ["alliances", "diplomacy", "generic"],
    conflict: ["conflict", "diplomacy"],
    policy: ["policy", "finance", "generic"],
    currency: ["currency", "liquidity", "finance"],
    energy: ["energy", "policy"],
    metals: ["metals", "trade"],
    food: ["food", "trade"],
    housing: ["housing", "finance"],
    labor: ["labor", "policy"],
    finance: ["finance", "liquidity", "debt"],
    tech: ["tech", "policy"],
    disaster: ["disaster", "liquidity"],
    migration: ["migration", "labor"],
    sanctions: ["sanctions", "trade", "finance"],
    liquidity: ["liquidity", "finance"],
    debt: ["debt", "default", "finance"],
    default: ["default", "debt"],
    rally: ["rally", "local_markets"],
    crash: ["crash", "liquidity", "local_markets"],
    generic: ["generic"]
  };
  const focus = phaseBias[label] || ["generic"];
  for (const k of Object.keys(base)) base[k] = 0.2;
  for (const k of focus) base[k] = (base[k] || 0) + 1.5;

  if (isMAX) {
    for (const k of ["crash", "default", "liquidity", "conflict", "sanctions", "currency"]) {
      base[k] = (base[k] || 0) + 0.6;
    }
  }
  return base;
}

function renderTemplate(tpl, ctx) {
  const out = tpl
    .replaceAll("{A}", ctx.A ?? "")
    .replaceAll("{B}", ctx.B ?? "")
    .replaceAll("{C}", ctx.C ?? "")
    .replaceAll("{rival}", ctx.rival ?? "")
    .replaceAll("{M}", ctx.M ?? "")
    .replaceAll("{commodity}", ctx.commodity ?? "")
    .replaceAll("{pct}", ctx.pct ?? "")
    .replaceAll("{amount}", ctx.amount ?? "")
    .replaceAll("{price}", ctx.price ?? "")
    .replaceAll("{index}", ctx.index ?? "");
  return out.replace(/\{[^}]+\}/g, "").replace(/\s{2,}/g, " ").trim();
}

function makeContext(world) {
  const [A, B, C] = pickRegimeNames(world, 3);
  const rival = pickRival(world, [A, B, C]);
  const M = pickMarket(world);
  const commodity = pickCommodity(world);
  const vol = Number(world?.globals?.volMul ?? 1.0);
  const shock = Number(world?.globals?.shockMul ?? 1.0);
  const pctVal = clamp((0.3 + Math.random() * 4.7) * (0.6 + 0.4 * vol) * (0.7 + 0.3 * shock), 0.2, 9.9);
  const rawAmt = (5e4 + Math.random() * 1.95e6) * (0.5 + 0.5 * vol);
  const priceVal = clamp((0.3 + Math.random() * 199.7) * (0.5 + 0.7 * shock), 0.2, 500);
  const indexVal = 900 + Math.random() * 4300;

  const unit = /crude|diesel|lng/i.test(commodity) ? "bbl"
             : /wheat|maize|rice/i.test(commodity) ? "t"
             : /copper|nickel|lithium|gold/i.test(commodity) ? "t"
             : "";

  const ccy = /FX|currency/i.test(M) ? "" : "$";

  return {
    A, B, C, rival, M, commodity,
    pct: fmtPct(pctVal),
    amount: fmtAmount(rawAmt, unit),
    price: fmtPrice(priceVal, ccy),
    index: fmtIndex(indexVal)
  };
}

function normalizeLabel(label) {
  if (!label) return "generic";
  const s = String(label).toLowerCase();
  if (/global/.test(s)) return "globals";
  if (/local/.test(s)) return "local_markets";
  if (/market/.test(s)) return "local_markets";
  if (/trade/.test(s)) return "trade";
  if (/ally|alliance/.test(s)) return "alliances";
  if (/diplo|treaty|summit|talk/.test(s)) return "diplomacy";
  if (/conflict|skirmish|border|milit/.test(s)) return "conflict";
  if (/policy|cb|tax|levy|cap/.test(s)) return "policy";
  if (/fx|currency/.test(s)) return "currency";
  if (/energy|power|fuel|gas|oil/.test(s)) return "energy";
  if (/metal|mine|smelt|ore/.test(s)) return "metals";
  if (/food|grain|harvest|crop/.test(s)) return "food";
  if (/house|mortgage|rent|permit/.test(s)) return "housing";
  if (/labor|wage|union|strike/.test(s)) return "labor";
  if (/finance|bank|credit|equity|bond/.test(s)) return "finance";
  if (/tech|data|spectrum|ai/.test(s)) return "tech";
  if (/disaster|flood|quake|storm|wildfire|heatwave/.test(s)) return "disaster";
  if (/migrat|refugee|visa|diaspora/.test(s)) return "migration";
  if (/sanction|ofac|export control/.test(s)) return "sanctions";
  if (/liquid|repo|mmf|funding/.test(s)) return "liquidity";
  if (/debt|arrear|bond|coupon|imf|eurobond/.test(s)) return "debt";
  if (/default|standstill|haircut/.test(s)) return "default";
  if (/rally|squeeze|rebound|bid/.test(s)) return "rally";
  if (/crash|selloff|limit down|capitulat/.test(s)) return "crash";
  return "generic";
}

export function makeNarrativeForPhase(NARR, label, world) {
  try {
    const bucket = normalizeLabel(label);
    const weightsMap = bucketWeightsFor(bucket, NARR, world);
    const buckets = Object.keys(NARR);

    const candidates = [];
    const wts = [];
    for (const b of buckets) {
      const arr = NARR[b];
      if (!arr || arr.length === 0) continue;
      const w = weightsMap[b] ?? 0.2;
      candidates.push(pick(arr));
      wts.push(w);
    }

    const tpl = pick(candidates, wts);
    const ctx = makeContext(world);
    const line = renderTemplate(tpl, ctx);
    return line || "";
  } catch {
    return "";
  }
}
