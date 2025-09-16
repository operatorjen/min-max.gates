import { randomBytes, createHash } from "node:crypto";
import fs from "node:fs";

const cfg = JSON.parse(fs.readFileSync(new URL("./rules.json", import.meta.url)));

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const z = (x, mean = 0, std = 1) => (std > 0 ? (x - mean) / std : 0);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const b64u = (buf) => Buffer.from(buf).toString("base64url");

function randn() {
  let u=0, v=0; while(!u) u=Math.random(); while(!v) v=Math.random();
  return Math.sqrt(-2*Math.log(u)) * Math.cos(2*Math.PI*v);
}

export const SCORE_TTL = cfg.scoreTTL;
const MIN_R = cfg.regimes.min, MAX_R = cfg.regimes.max;

export const CATS = ["RE","S","B","C","F","M","G","W","T","I"];
const CAT_LABEL = {
  RE: "RealEst",
  S: "Stocks",
  B: "Bonds",
  C: "Commodities",
  F: "Food",
  M: "Metals",
  G: "Goods",
  W: "Wages",
  T: "Tradables",
  I: "Infra"
};
const CAT_META = {
  RE: { tradable: false, capLike: true },
  S: { tradable: true, financial: true },
  B: { tradable: true, financial: true },
  C: { tradable: true, financial: true },
  F: { tradable: true },
  M: { tradable: true },
  G: { tradable: true, perishable: true },
  W: { tradable: true, perishable: true },
  T: { tradable: true, intangible: true },
  I: { tradable: false, capLike: true },
};

function _progress(cb, pct, label) { try { cb && cb(pct, label); } catch {} }

export function newWorld(nR = 4) {
  nR = Math.max(MIN_R, Math.min(MAX_R, nR|0));
  const worldId = b64u(randomBytes(12));
  const g = initGlobals();
  const regimes = initRegimes(nR, g);
  return {
    id: worldId,
    step: 0,
    globals: g,
    regimes,
    alliances: [],
    conflicts: [],
    conflictLog: [],
  };
}

function initGlobals() {
  return {
    GG: cfg.globalsInit.GG,
    IR: cfg.globalsInit.IR,
    RA: cfg.globalsInit.RA,
    ES: cfg.globalsInit.ES,
    TS: cfg.globalsInit.TS,
    CS: cfg.globalsInit.CS,
    substeps: cfg.globalsInit.substeps,
    turnYears: cfg.globalsInit.turnYears,
    volMul: cfg.globalsInit.volMul,
  };
}

function dirichlet(k, alpha=1.0) {
  const xs = Array.from({length:k}, () => -Math.log(Math.random()) / alpha);
  const s = xs.reduce((a,b)=>a+b,0);
  return xs.map(v => v / s);
}

function initRegimes(nR, g) {
  const landShares = dirichlet(nR, 0.8).map(v => v);
  const popBias = dirichlet(nR, 1.3);
  const basePop = landShares.map((ls, i) => clamp((0.6*popBias[i] + 0.4*(1-ls)) * 1.5, 0.05, 0.9));
  
  const fuelEndow = dirichlet(nR, 0.9);
  const mineralEndow = dirichlet(nR, 1.0);
  const arableEndow = dirichlet(nR, 1.1);
  const waterEndow = dirichlet(nR, 1.0);

  const regimes = [];
  for (let i=0;i<nR;i++) {
    const LS = landShares[i];
    const PD = clamp(basePop[i], 0.05, 0.95);
    const EA = clamp(0.3 + 0.5*Math.random() + 0.2*PD, 0.2, 0.95);
    const TA = clamp(0.2 + 0.5*Math.random(), 0.05, 0.95);
    const PS = clamp(0.4 + 0.3*Math.random(), 0.1, 0.95);

    const endow = {
      fuel:  clamp(fuelEndow[i]   + 0.2*LS, 0, 1),
      mineral: clamp(mineralEndow[i]+ 0.1*LS, 0, 1),
      arable: clamp(arableEndow[i] + 0.3*LS, 0, 1),
      water: clamp(waterEndow[i]   + 0.1*LS, 0, 1),
    };

    const market = {};
    for (const k of CATS) market[k] = seedAsset(k, {LS, PD, EA, TA, PS}, endow, g);

    const id = shortId(`${i}-${LS}-${PD}`);
    const name = `R-${id}`;
    const CI = 0.45*(endow.fuel+endow.mineral)/2 + 0.2*(1/Math.max(0.15, EA)) + 0.1*(1-PS);
    const type = typeFromCI(CI);

    regimes.push({
      id, name,
      externals: { LS, PD, EA, TA, PS },
      endow,
      market,
      ci: clamp(CI,0,1),
      type,
      wealth: 1.0,
      tradeOpen: 0.2 + 0.2*Math.random(),
      debts: 0.2*Math.random(),
      lastTrades: [],
    });
  }
  return regimes;
}

function seedAsset(cat, E, endow, G) {
  const base = () => 0.2 + 0.6*Math.random();
  const S = (() => {
    switch(cat) {
      case "RE": return 0.5*E.LS + 0.2*E.EA + 0.1;
      case "S": return 0.3*E.EA + 0.3*E.TA + 0.2;
      case "B": return 0.4*E.PS + 0.2*E.EA + 0.1;
      case "C": return 0.5 + 0.3*E.PS;
      case "F": return 0.4*endow.fuel + 0.2*E.EA;
      case "M": return 0.4*endow.mineral + 0.2*E.EA;
      case "G": return 0.5*endow.arable + 0.2*E.LS;
      case "W": return 0.4*endow.water + 0.2*E.LS;
      case "T": return 0.3*E.TA + 0.1*E.EA;
      case "I": return 0.3*E.EA + 0.2*E.PS;
      default: return base();
    }
  })();
  const D = (() => {
    switch(cat) {
      case "RE": return 0.5*E.PD + 0.3*E.EA + 0.2;
      case "S": return 0.4*E.EA + 0.2*E.TA + 0.2;
      case "B": return 0.3*(1-E.PS) + 0.2*E.EA;
      case "C": return 0.3 + 0.2*(G.RA+0.5) + 0.2*(1-E.PS);
      case "F": return 0.4*E.EA + 0.1;
      case "M": return 0.3*E.EA + 0.1*E.TA;
      case "G": return 0.4*(E.PD*E.LS) + 0.2;
      case "W": return 0.4*(E.PD*E.LS) + 0.1;
      case "T": return 0.4*E.TA + 0.2*E.EA;
      case "I": return 0.2 + 0.4*E.EA;
      default: return base();
    }
  })();

  const L = (cat==="C") ? 0.95 : (cat==="S"||cat==="B") ? 0.7 : (cat==="RE"||cat==="I") ? 0.2 : 0.5;
  const V = (cat==="C") ? 0.05 : (cat==="S"||cat==="F"||cat==="G") ? 0.4 : 0.25;
  const Rk = 0.2 + 0.6*Math.random();
  const ER = 0.02 + 0.05*Math.random();

  const Inv = (CAT_META[cat]?.capLike) ? 1.0 : (CAT_META[cat]?.perishable ? 0.2 : 0.5);
  const Prod = Math.max(0.05, S - 0.3);
  const τ = 0.1 + 0.2*Math.random();

  const price = 1.0;
  return { S, D, V, L, Rk, ER, Inv, Prod, τ, price };
}

function ensureMarketCompleteness(R, G) {
  R.market ||= {};
  const E = R.externals || {};
  for (const k of CATS) {
    if (!R.market[k]) {
      R.market[k] = seedAsset(k, E, R.endow || {}, G || {});
    }
  }
}

export function stepWorld(world, onProgress) {
  const G = world.globals;
  const K   = Math.max(1, Math.floor(Number(G.substeps || cfg.globalsInit.substeps)));
  _progress(onProgress, 0.00, "start");
  world.step += 1;

  _progress(onProgress, 0.05, "globals");
  tickGlobals(world.globals);

  const n = world.regimes.length || 1;
  world.regimes.forEach((R, i) => {
    ensureMarketCompleteness(R, G);
    localMarketUpdate(R, world.globals, K);
    _progress(onProgress, 0.10 + 0.30 * ((i + 1) / n), "local_markets");
  });

  _progress(onProgress, 0.65, "conflicts");
  world.conflicts = [];
  maybeConflict(world);

  _progress(onProgress, 0.45, "trade");
  runTrade(world);

  _progress(onProgress, 0.55, "alliances");
  maybeAlliance(world);

  _progress(onProgress, 0.75, "migration");
  migration(world);

  world.regimes.forEach((R, i) => {
    updateRegimeType(R, world);
    degradeAndInvest(R);
    _progress(onProgress, 0.80 + 0.15 * ((i + 1) / n), "regime_updates");
  });

  _progress(onProgress, 0.96, "cleanup");

  const beforeRegs = world.regimes.map(r => ({ ...r, externals: { ...r.externals } }));

  world.regimes = world.regimes.filter(R =>
    R.externals.PS > cfg.filters.minPS && R.wealth > cfg.filters.minWealth && (R.externals.PD * R.externals.LS) > cfg.filters.minPopLand
  );

  const afterIds = new Set(world.regimes.map(r => r.id));
  const fellNow = beforeRegs.filter(r => !afterIds.has(r.id));

  world.fallReasons = world.fallReasons || {};
  for (const R of fellNow) {
    const E = R.externals || {};
    const reasons = [];

    if (E.PS <= cfg.filters.minPS) reasons.push("state capacity collapsed (low Stability)");
    if (R.wealth <= cfg.filters.minWealth) reasons.push("economic output collapsed (low Wealth)");
    if ((E.PD * E.LS) <= cfg.filters.minPopLand) reasons.push("population & territory too small");

    const hit = (world.conflicts || []).find(e => e.to === R.id);
    if (hit) {
      world.fallReasons[R.id] = {
        text: reasons.length ? `${reasons[0]}; defeated by ${hit.from}` : `defeated by ${hit.from}`,
        by: hit.from
      };
    } else {
      world.fallReasons[R.id] = {
        text: reasons[0] || "systemic failure (multiple stresses)"
      };
    }
  }
  _progress(onProgress, 1.00, "done");
  return world;
}

function tickGlobals(G) {
  const jitter = (x, target, sigma=0.1, rho=0.9) => rho*x + (1-rho)*target + sigma*(Math.random()-0.5);
  G.GG = clamp(jitter(G.GG, 0.0, 0.12), -0.8, 0.8);
  G.IR = clamp(jitter(G.IR, 0.02, 0.02, 0.95), 0.0, 0.15);
  G.RA = clamp(jitter(G.RA, 0.0, 0.15), -0.5, 1.0);
  G.ES = clamp(jitter(G.ES, 0.0, 0.2), -0.5, 1.0);
  G.TS = clamp(jitter(G.TS, 0.0, 0.2), -0.5, 1.0);
  G.CS = clamp(jitter(G.CS, 0.0, 0.2), -0.5, 1.0);
}

function nextPriceGBM(a, G, dtY=1) {
  const mu = (a.ER ?? 0.03) - (a.Rk ?? 0.00);
  const sigma = (a.V ?? 0.20) * (G.volMul ?? cfg.globalsInit.volMul);
  const dW = randn() * Math.sqrt(Math.max(1e-6, dtY));
  const drift = (mu - 0.5 * sigma * sigma) * dtY;
  const shock = sigma * dW;
  return Math.max(0.01, (a.price ?? 1) * Math.exp(drift + shock));
}

function localMarketUpdate(R, G, K) {
  const E = R.externals;
  for (const k of CATS) {
    const a = R.market?.[k];
    if (!a) continue;
    const dShock =
      (k==="S" ? 0.3*G.GG - 0.3*G.RA :
       k==="B" ? -0.3*G.IR - 0.2*G.RA :
       k==="RE"? 0.2*G.GG - 0.2*G.IR :
       k==="F" ? 0.2*G.GG + 0.4*G.ES :
       k==="G"? 0.1*G.GG - 0.3*G.CS :
       k==="W" ? -0.4*G.CS :
       k==="T" ? 0.4*G.TS :
       k==="C" ? 0.2*G.RA + 0.2*(1-E.PS) :
                 0.1*G.GG);

    a.D = clamp(a.D + 0.2*dShock, 0.05, 2.0);

    const sShock =
      (k==="F" ?  0.3*R.endow.fuel - 0.3*G.ES :
       k==="M" ?  0.3*R.endow.mineral :
       k==="G"?  0.3*R.endow.arable - 0.3*G.CS :
       k==="W" ?  0.3*R.endow.water - 0.3*G.CS :
       k==="T" ?  0.3*E.TA + 0.2*G.TS :
                 0.1*E.EA);

    a.S = clamp(a.S + 0.15*sShock, 0.05, 2.5);

    const dtY = Math.max(0.25, Number(G.turnYears || cfg.globalsInit.turnYears)); 
    a.price = nextPriceGBM(a, G, dtY / K);

    if (k==="B") a.ER = clamp(0.02 + 0.01 - G.IR - 0.01*(1-E.PS), -0.1, 0.1);
    else if (k==="S") a.ER = clamp(0.05 + 0.02*G.GG - 0.02*G.RA, -0.2, 0.3);
    else if (k==="RE") a.ER = clamp(0.03 + 0.01*G.GG - 0.02*G.IR, -0.1, 0.2);
    else if (k==="C") a.ER = clamp(-0.01 + 0.5*G.IR, -0.05, 0.05);
    else a.ER = clamp(0.02 + 0.01*(G.GG), -0.1, 0.2);

    if (CAT_META[k]?.capLike) {
      a.Inv = clamp(a.Inv + 0.02*(E.EA + E.PS - 1.0), 0.1, 3.0);
    } else {
      const net = a.Prod + 0.2*a.S - 0.2*a.D;
      const decay = CAT_META[k]?.perishable ? 0.1 : 0.02;
      a.Inv = clamp(a.Inv + 0.1*net - decay*a.Inv, 0.01, 2.0);
    }
  }

  const out = CATS.reduce((sum,k)=>{
    const a = R.market[k];
    const flow = Math.min(a.S + 0.2*a.Inv, a.D);
    return sum + flow * a.price;
  }, 0);
  R.wealth = clamp(0.7*R.wealth + 0.3*(out/ CATS.length), 0.05, 5.0);
}

function orderInclusionScores(R, world) {
  const E = R.externals;
  const pop = Math.max(1e-3, E.PD * E.LS);
  const wpc = R.wealth / pop;

  let O =
    cfg.orderWeights.O.PS * clamp(E.PS) +
    cfg.orderWeights.O.IInv * clamp(R.market?.I?.Inv ?? 0) + 
    cfg.orderWeights.O.tradeOpen * clamp(R.tradeOpen) +
    cfg.orderWeights.O.ally * (world.alliances?.some(p => p.includes?.(R.id)) ? 1 : 0) +
    cfg.orderWeights.O.loss * clamp(R.lastConflictLoss || 0) +
    cfg.orderWeights.O.vol * clamp(z(R.volatility12m || cfg.orderWeights.O.volMean, cfg.orderWeights.O.volMean, cfg.orderWeights.O.volStd), -1, 1);

  let I =
    cfg.orderWeights.I.wpc * clamp(Math.log1p(wpc) / Math.log(1+cfg.orderWeights.I.wpcMax)) +
    cfg.orderWeights.I.civic * clamp(R.civicVoice ?? 0.4) + 
    cfg.orderWeights.I.tradeOpen * clamp(R.tradeOpen) +
    cfg.orderWeights.I.rents * clamp(R.eliteRents ?? ((R.market?.F?.price + R.market?.M?.price) / 200), 0, 1) +
    cfg.orderWeights.I.media * clamp(R.mediaControl ?? 0.3) +
    cfg.orderWeights.I.loss * clamp(R.lastConflictLoss || 0);

  return { O: clamp(O, 0, 1), I: clamp(I, 0, 1) };
}

export function isPlayerAlive(world) {
  const pid = world.player?.id;
  if (!pid) return true;
  return world.regimes.some(r => r.id === pid);
}

export function markGameOverIfNeeded(world) {
  if (!isPlayerAlive(world)) {
    world.done = true;
    world.endedAt = world.step;
    const pid = world.player?.id;
    if (pid && world.fallReasons && world.fallReasons[pid]) {
      world.playerFall = world.fallReasons[pid]; 
    }
  }
  return world.done === true;
}

export function updateRegimeType(R, world) {
  const { O, I } = orderInclusionScores(R, world);

  R._mem = R._mem || { D:0, A:0, T:0, N:0 };
  const bump = (k) => { R._mem[k] = Math.min(5, (R._mem[k] || 0) + 1); for (const kk of ["D","A","T","N"]) if (kk!==k) R._mem[kk] = Math.max(0, R._mem[kk]-1); };

  const tD = (O >= 0.55 && I >= 0.55);
  const tA = (O >= 0.55 && I <  0.55);
  const tT = (O <  0.40 && I <  0.40);
  const tN = (O <  0.25 && I <  0.25);

  if (tD) bump("D");
  else if (tA) bump("A");
  else if (tT) bump("T");
  else if (tN) bump("N");
  else bump(R.type || "A");

  const win = Object.entries(R._mem).sort((a,b)=>b[1]-a[1])[0][0];
  const prev = R.type || "A";
  const need = { D:cfg.typeMemory.D, A:cfg.typeMemory.A, T:cfg.typeMemory.T, N:cfg.typeMemory.N };
  R.type = (R._mem[win] >= need[win]) ? win : prev;

  R.ci = 0.6 * O + 0.4 * I;
}

function runTrade(world) {
  const pairs = [];
  for (const cat of CATS.filter(k => CAT_META[k].tradable)) {
    const sur = [], def = [];
    for (const R of world.regimes) {
      const a = R.market?.[cat];
      if (!a) continue;
      const gap = (a.S + 0.3*a.Inv) - a.D;
      if (gap > cfg.trade.gapThresh) sur.push({R, gap, a});
      if (gap < -cfg.trade.gapThresh) def.push({R, gap: -gap, a});
    }
    sur.sort((x,y)=>y.gap - x.gap);
    def.sort((x,y)=>y.gap - x.gap);
    let i=0,j=0, guard=0;
    while (i<sur.length && j<def.length && guard < cfg.trade.guard) {
      guard++;
      const s=sur[i], d=def[j];
      const vol = Math.min(s.gap, d.gap) * cfg.trade.volFrac;
      if (vol <= 1e-6) {
        if (s.gap <= d.gap) i++; else j++;
        continue;
      }
      const tradeCost = 0.5*(s.R.market[cat].τ + d.R.market[cat].τ);
      if (vol > 0) {
        s.a.Inv = Math.max(0.01, s.a.Inv - 0.2*vol);
        d.a.Inv = clamp(d.a.Inv + 0.2*vol, 0.01, 2.5);
        s.R.externals.EA = clamp(s.R.externals.EA + cfg.trade.eaFrom*vol - 0.005*tradeCost, 0.05, 1);
        d.R.externals.EA = clamp(d.R.externals.EA + cfg.trade.eaTo*vol - 0.003*tradeCost, 0.05, 1);
        s.R.externals.PS = clamp(s.R.externals.PS + cfg.trade.psFrom*vol, 0.01, 1);
        d.R.externals.PS = clamp(d.R.externals.PS + cfg.trade.psTo*vol, 0.01, 1);
        s.R.tradeOpen = clamp(s.R.tradeOpen + cfg.trade.openFrom*vol, 0, 1);
        d.R.tradeOpen = clamp(d.R.tradeOpen + cfg.trade.openTo*vol, 0, 1);

        if (cat==="T") d.R.externals.TA = clamp(d.R.externals.TA + cfg.trade.tTechGain*vol, 0, 1);
        pairs.push({cat, from:s.R.id, to:d.R.id, vol});
      }
      s.gap -= vol; d.gap -= vol;
      if (s.gap <= 0.02) i++;
      if (d.gap <= 0.02) j++;
    }
  }

  for (const R of world.regimes) R.lastTrades = pairs.filter(p=>p.from===R.id||p.to===R.id).slice(0,5);
}

function maybeAlliance(world) {
  for (const R of world.regimes) {
    for (const Q of world.regimes) {
      if (R.id===Q.id) continue;
      const already = world.alliances.find(a=>(a[0]===R.id&&a[1]===Q.id)||(a[0]===Q.id&&a[1]===R.id));
      if (already) continue;
      const interacts = R.lastTrades.some(t=>t.to===Q.id||t.from===Q.id);
      const allianceChance = interacts ? cfg.alliance.base * (1 - cfg.alliance.ciWeight*(R.ci+Q.ci)) : 0.0;
      if (Math.random() < allianceChance) {
        world.alliances.push([R.id, Q.id]);
        for (const k of CATS) {
          R.market[k].τ = Math.max(cfg.alliance.τMin, R.market[k].τ - cfg.alliance.τDelta);
          Q.market[k].τ = Math.max(cfg.alliance.τMin, Q.market[k].τ - cfg.alliance.τDelta);
        }
        R.externals.PS = clamp(R.externals.PS + cfg.alliance.psBump, 0, 1);
        Q.externals.PS = clamp(Q.externals.PS + cfg.alliance.psBump, 0, 1);
      }
    }
  }
}

function maybeConflict(world) {
  const G = world.globals;
  for (const R of world.regimes) {
    const sc =
      deficitScore(R.market.G) + deficitScore(R.market.W) + 0.5*deficitScore(R.market.F);
    const pConflict = clamp(cfg.conflict.coefDeficit*sc + cfg.conflict.coefCI*(R.ci>0.6) - cfg.conflict.coefPS*R.externals.PS, 0, cfg.conflict.pMax);
    if (Math.random() < pConflict && world.regimes.length >= 2) {
      const targets = world.regimes.filter(Q => Q.id!==R.id);
      const T = pick(targets);
      const dLS = Math.min(cfg.conflict.dLSMaxFrac, cfg.conflict.dLSFracOfTarget*T.externals.LS);
      R.externals.LS = clamp(R.externals.LS + dLS, 0.01, 1);
      T.externals.LS = clamp(T.externals.LS - dLS, 0.01, 1);
      R.externals.PS = clamp(R.externals.PS - cfg.conflict.psLossAttacker, 0.01, 1);
      T.externals.PS = clamp(T.externals.PS - cfg.conflict.psLossDefender, 0.01, 1);
      R.market.I.Inv = Math.max(0.1, cfg.conflict.invHitAttacker*R.market.I.Inv);
      T.market.I.Inv = Math.max(0.1, cfg.conflict.invHitDefender*T.market.I.Inv);
      T.lastConflictLoss = (T.lastConflictLoss || 0) + dLS;
      R.lastConflictLoss = Math.max(0, (R.lastConflictLoss || 0) * 0.8);
      G.RA = clamp(G.RA + cfg.conflict.raBump, -0.5, 1.0);
      world.conflicts.push({at: world.step, from:R.id, to:T.id, dLS});
      (world.conflictLog ||= []).push({at: world.step, from:R.id, to:T.id, dLS});
      if (world.conflictLog.length > cfg.conflict.logMax) {
        world.conflictLog.splice(0, world.conflictLog.length - cfg.conflict.logMax);
      }
    }
  }
}

function deficitScore(a) {
  if (!a) return 0;
  const s = Number.isFinite(a.S) ? a.S : 0;
  const d = Number.isFinite(a.D) ? a.D : 0;
  const inv = Number.isFinite(a.Inv) ? a.Inv : 0;
  const gap = (d - (s + 0.3*inv));
  return Math.max(0, gap);
}

function migration(world) {
  const src = world.regimes.filter(R => R.externals.PS < cfg.migration.srcPS);
  const dst = world.regimes.filter(R => R.externals.PS > cfg.migration.dstPS);
  if (!src.length || !dst.length) return;
  for (const R of src) {
    const Q = pick(dst);
    const flow = cfg.migration.flowK * (cfg.migration.dstPS - R.externals.PS);
    R.externals.PD = clamp(R.externals.PD * (1 - flow), 0.02, 1.5);
    Q.externals.PD = clamp(Q.externals.PD * (1 + flow), 0.02, 1.5);
    R.externals.EA = clamp(R.externals.EA - cfg.migration.eaLoss*flow, 0.01, 1);
    Q.externals.EA = clamp(Q.externals.EA + cfg.migration.eaGain*flow, 0.01, 1);
  }
}

function degradeAndInvest(R) {
  const sign = (R.externals.PS > 0.5) ? 1 : -1;
  R.market.I.Inv = clamp(R.market.I.Inv + cfg.degrade.iInvStep*sign, 0.1, 3.0);
  R.externals.TA = clamp(R.externals.TA + cfg.degrade.taOpenK*R.tradeOpen + cfg.degrade.taSelfK*(R.externals.TA), 0, 1);
  R.externals.PS = clamp(cfg.degrade.psDecay*R.externals.PS + cfg.degrade.psMix*cfg.degrade.psTarget, 0.01, 1);
}

function typeFromCI(ci) {
  return (ci < cfg.typeBands.N) ? "N" : (ci < cfg.typeBands.D) ? "D" : (ci < cfg.typeBands.A) ? "A" : "T";
}

function shortId(s) {
  return createHash("sha256").update(s).digest("base64url").slice(0,6);
}

export async function saveWorld(r, gameToken, world) {
  const key = `sim:game:${gameToken}`;
  const val = JSON.stringify(world);
  if (r?.isOpen) {
    await r.set(key, val, { EX: SCORE_TTL, XX: false });
  } else {
    mem.set(key, val);
  }
}

export async function loadWorld(r, gameToken) {
  const key = `sim:game:${gameToken}`;
  if (r?.isOpen) {
    const s = await r.get(key);
    return s ? JSON.parse(s) : null;
  } else {
    const s = mem.get(key);
    return s ? JSON.parse(s) : null;
  }
}

export async function touchWorldTTL(r, gameToken) {
  const key = `sim:game:${gameToken}`;
  if (r?.isOpen) await r.expire(key, SCORE_TTL);
}

const mem = new Map();

export function newGameToken() {
  return b64u(randomBytes(16));
}

export async function startGame(r, opts = {}) {
  const nR = typeof opts === "number" ? opts : Number(opts.nR ?? 4);
  const world = newWorld(nR);

  if (typeof opts === "object" && opts) {
    const rule = String(opts.select || "rand");
    const player = selectPlayer(world, rule);
    world.player = { id: player.id, name: player.name, rule };
    player.isPlayer = true;
  }

  const game = newGameToken();
  await saveWorld(r, game, world);
  return { game, world };
}

function selectPlayer(world, rule = "rand") {
  const Rs = world.regimes;
  if (rule === "largest")   return [...Rs].sort((a,b)=>b.externals.LS - a.externals.LS)[0];
  if (rule === "wealthiest")return [...Rs].sort((a,b)=>b.wealth - a.wealth)[0];
  if (rule === "techiest")  return [...Rs].sort((a,b)=>b.externals.TA - a.externals.TA)[0];
  return Rs[(Math.random() * Rs.length) | 0];
}

export async function stepGame(r, game, onProgress) {
  const world = await loadWorld(r, game);
  if (!world) return null;
  stepWorld(world, onProgress);
  markGameOverIfNeeded(world);
  _progress(onProgress, 1.00, "done");
  await saveWorld(r, game, world);
  return world;
}

const visWidth = (s) => {
  const str = String(s ?? "");
  const graphemes = [...str];
  const emojiCount = (str.match(/\p{Extended_Pictographic}/gu) || []).length;
  const cjkCount   = (str.match(/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/g) || []).length;
  return graphemes.length + emojiCount + cjkCount;
};
const padVis = (s, w, alignRight = false) => {
  const str = String(s ?? "");
  const need = Math.max(0, w - visWidth(str));
  return alignRight ? " ".repeat(need) + str : str + " ".repeat(need);
};

export function worldSnapshot(world) {
  const f = (x, n = 2) => (Number.isFinite(x) ? x.toFixed(n) : "—");

  const pad = (s, w, alignRight = true) =>
    (alignRight ? String(s).padStart(w) : String(s).padEnd(w));
  const typeLabel = (t) =>
    ({ N: "Anarchia", D: "Democratia", A: "Auctoritas", T: "Imperium" }[t] || t);

  const G = world.globals;

  const globals =
`GLOBAL SIGNALS
--------------
Growth (GG)           : ${f(G.GG, 2)}       Interest Rate (IR)    : ${f(G.IR * 100, 1)}%
Risk Aversion (RA)    : ${f(G.RA, 2)}       Energy Shock (ES)     : ${f(G.ES, 2)}
Tech Shock (TS)       : ${f(G.TS, 2)}       Climate Shock (CS)    : ${f(G.CS, 2)}`;

  const w = 10;
  const headers1 = [
    pad(" ", 2, false),
    pad("Name", w, false),
    pad("Type", w + 2),
    pad("CapInt", w),
    pad("Land", w),
    pad("PopDen", w),
    pad("EconAct", w),
    pad("TechAdv", w),
    pad("PolStab", w),
    pad("Wealth%", w),
    pad("Trade", w),
    pad("RentSh%", w),
  ].join("");

  const sep1 = "-".repeat(headers1.length);

  const rows1 = world.regimes.map((R) => {
    const X = R.externals || {};
    const star = " ";
    const rentierShare = Number.isFinite(R.rentierShare) ? R.rentierShare : (R?.wealth ?? 0) * 0.1;
    return (
      pad(star, 2, false) +
      pad(R.name, w, false) +
      pad(typeLabel(R.type), 5) +
      pad(f(R.ci, 2), w) +
      pad(f(X.LS, 2), w) +
      pad(f(X.PD, 2), w) +
      pad(f(X.EA, 2), w) +
      pad(f(X.TA, 2), w) +
      pad(f(X.PS, 2), w) +
      pad(f(R.wealth, 2), w) +
      pad(f(R.tradeOpen, 2), w) +
      pad(f(rentierShare, 2), w)
    );
  });

  const COLUMNS = CATS.map(key => ({ key, label: CAT_LABEL[key] || key }));

  const nameLead = pad(" ", 2, false) + pad(" ", w);
  const H2 = nameLead + COLUMNS.map((c, i) => pad(c.label, w, false)).join("");
  const sep2 = "-".repeat(H2.length);

  const rows2 = world.regimes.map((R) => {
    const m = R.market || {};
    const star = " ";
    const nameCell = pad(star, 2, false) + pad(R.name, w / 2, false);
    const cells = COLUMNS.map((c, i) => {
      const price = m[c.key]?.price;
      return pad(f(Number.isFinite(price) ? price : NaN, 2), w);
    });
    return nameCell + cells.join("");
  });

  const lastConf = (world.conflicts || []).slice(-5).map(e => {
    const from = world.regimes.find(x => x.id === e.from)?.name || e.from;
    const to   = world.regimes.find(x => x.id === e.to)?.name   || e.to;
    return ` • t=${e.at}: ${from} → ${to} (land +${f(e.dLS, 3)})`;
  });

  const BL = "\u200B";

  return [
    globals,
    BL,
    "FUNDAMENTALS",
    sep1,
    headers1,
    sep1,
    ...rows1,
    sep1,
    BL,
    "MARKETS",
    sep2,
    H2,
    sep2,
    ...rows2,
    sep2,

    lastConf.length ? "CONFLICTS\n-----------------" : "",
    ...lastConf,
    BL
  ].join("\n");
}
