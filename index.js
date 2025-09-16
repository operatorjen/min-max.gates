import dotenv from "dotenv"; dotenv.config();
import http from "node:http";
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createClient } from "redis";
import { startGame, stepGame, loadWorld, worldSnapshot, SCORE_TTL, saveWorld } from "./core.js";
import { loadNarrative, makeNarrativeForPhase } from "./narrative.js";

const MIN = {
  name: "MIN",
  rate_limit: { ip: 60, window: 60 },
  token_ttl:  600,
  body_limit: 64 * 1024,
  shockMul: Number(process.env.SHOCK_MUL_MIN || 1.0),
  volMul:   Number(process.env.VOL_MUL_MIN  || process.env.volMul || 1.0),
  turnYears:Number(process.env.TURN_YEARS_MIN || 1.0),
  substeps: Number(process.env.SUBSTEPS_MIN   || 2),
  points:   Number(process.env.PLAYER_POINTS_MIN || 1.0)
};
const MAX = {
  name: "MAX",
  rate_limit: { ip: 30, window: 60 },
  token_ttl:  300,
  body_limit: 64 * 1024,
  shockMul: Number(process.env.SHOCK_MUL_MAX || 1.6),
  volMul:   Number(process.env.VOL_MUL_MAX   || 1.4),
  turnYears:Number(process.env.TURN_YEARS_MAX || 3.0),
  substeps: Number(process.env.SUBSTEPS_MAX   || 6),
  points:   Number(process.env.PLAYER_POINTS_MAX || 0.6)
};
const COLLAPSE = {
  HEALTH: Number(process.env.COLLAPSE_HEALTH ?? 0.12),
  HUMAN_HYST: Number(process.env.COLLAPSE_HUMAN_HYST ?? 5),
  NPC_HYST:   Number(process.env.COLLAPSE_NPC_HYST   ?? 3),
  GRACE_STEPS:Number(process.env.COLLAPSE_GRACE     ?? 5),

  FAMINE_MIN: Number(process.env.COLLAPSE_FAMINE_MIN ?? 0.03),
  BANK_LQFX:  Number(process.env.COLLAPSE_BANK_LQFX  ?? 0.04),
  BANK_DEBT:  Number(process.env.COLLAPSE_BANK_DEBT  ?? 1.25),
  REVOLT_U:   Number(process.env.COLLAPSE_REVOLT_U   ?? 0.98),
  REVOLT_A:   Number(process.env.COLLAPSE_REVOLT_A   ?? 0.15),
  INSTANT_S:  Number(process.env.COLLAPSE_INSTANT_S  ?? 0.04),
  INSTANT_A:  Number(process.env.COLLAPSE_INSTANT_A  ?? 0.10),
};
const ENV_MODE = (process.env.DIFFICULTY_MODE || "").toUpperCase();
const policyForHost = (host="") => host.startsWith("max.") ? MAX : MIN;
const POLICY_ENV = ENV_MODE === "MAX" ? MAX : (ENV_MODE === "MIN" ? MIN : null);

const PORT = Number(process.env.PORT || 3000);
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const SECRET = process.env.SECRET || randomBytes(32).toString("hex");
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const START_YEAR = Number.isFinite(Number(process.env.START_YEAR)) ? Number(process.env.START_YEAR) : (new Date()).getFullYear();
const MIN_SEATS = Number(process.env.MIN_SEATS || 4);
const MAX_SEATS = Number(process.env.MAX_SEATS || 10);
const EPOCH_SECONDS= Number(process.env.EPOCH_SECONDS || 60*60*24);
const GLOBAL_GAME_ID = "GLOBAL_WORLD";
const simKey = "sim:game:";
const MAX_SCORE = 9_000_000_000_000_000;
const MOVE_LOCK_TTL_S   = parseInt(process.env.MOVE_LOCK_TTL_S ?? "2", 10);
const MOVE_COOLDOWN_MS  = parseInt(process.env.MOVE_COOLDOWN_MS ?? "250", 10);

const r = createClient({ url: REDIS_URL, socket:{ connectTimeout:3000, keepAlive:5000, reconnectStrategy: t=>Math.min(t*100, 1000) }});
r.on("error", e => console.error("redis", e));
await r.connect();

const NARR = await loadNarrative("./narrative.json");

const now = () => Math.floor(Date.now()/1000);
const clamp = (x,a=0,b=1)=>Math.max(a,Math.min(b,Number.isFinite(x)?x:0));
const num = (x, lo, hi, d=0)=>clamp(Number.isFinite(Number(x))?Number(x):d, lo, hi);
const nfkc = s => (s && s.normalize) ? s.normalize("NFKC") : String(s ?? "");
const stripVS = s => String(s ?? "").replace(/[\uFE0E\uFE0F\u200D\u200C]/g,"");
const normKey = v => stripVS(nfkc(String(v ?? "").trim())).replace(/\s+/g," ");
const hmac = s => createHmac("sha256", SECRET).update(s).digest("base64url");
const sign = payload => { const p = Buffer.from(JSON.stringify(payload),"utf8").toString("base64url"); const m=hmac(p); return `${p}.${m}`; };
const verifyTok = tok => {
  if (!tok || typeof tok!=="string" || !tok.includes(".")) return null;
  const [p,m] = tok.split("."); const m2=hmac(p);
  if (m.length!==m2.length) return null;
  if (!timingSafeEqual(Buffer.from(m),Buffer.from(m2))) return null;
  try { return JSON.parse(Buffer.from(p,"base64url").toString("utf8")); } catch { return null; }
};
const json = (res, code, obj) => { res.writeHead(code, {"content-type":"application/json; charset=utf-8"}); res.end(JSON.stringify(obj)); };
const text = (res, code, s)   => { res.writeHead(code, {"content-type":"text/plain; charset=utf-8"});  res.end(s); };
const readBody = (req, limit)=> new Promise((ok, bad)=>{
  let s="", n=0; req.on("data",c=>{ n+=c.length; if(n>limit){ bad(new Error("too_large")); req.destroy(); return;} s+=c; });
  req.on("end",()=>ok(s)); req.on("error",bad);
});
const safeParse = s => { try { return JSON.parse(s||"{}"); } catch { return {}; } };
const bearer = req => { const h=req.headers.authorization||""; const m=/^Bearer (.+)$/.exec(h); return m?m[1]:""; };
const extractToken = (req,url)=> bearer(req) || url.searchParams.get("token") || "";
const ipHash = req => createHash("sha256").update(req.socket?.remoteAddress||"").digest("base64url").slice(0,16);
const currentEpoch = () => Math.floor(now()/EPOCH_SECONDS);

const SECURE_HEADERS = {
  "X-Policy": null, "X-No-Cookies":"1", "Referrer-Policy":"no-referrer", "X-Frame-Options":"DENY",
  "Cross-Origin-Opener-Policy":"same-origin", "Cross-Origin-Resource-Policy":"same-site", "X-Content-Type-Options":"nosniff",
};
const policyFromReq = req => {
  if (POLICY_ENV) return POLICY_ENV;
  const fwd = (req.headers["x-forwarded-host"]||"").toString().split(",")[0].trim();
  const host = (fwd || req.headers.host || "").toLowerCase();
  return policyForHost(host);
};
function setSecureHeaders(res, polName) { const H={...SECURE_HEADERS,"X-Policy":polName}; for (const [k,v] of Object.entries(H)) res.setHeader(k,v); }
async function rateGate(name, req, res, POL) {
  const ip = ipHash(req), key=`ratelimit:${name}:${ip}`, count = await r.incr(key);
  if (count===1) await r.expire(key, POL.rate_limit.window);
  if (count > POL.rate_limit.ip) { res.writeHead(429, {"retry-after":"10","content-type":"application/json"}); res.end(JSON.stringify({ok:false,err:"rate_limited"})); return false; }
  return true;
}

function rollingScoreFor(world, sub) {
  const integ = world._integrals?.[sub];
  if (!integ) return null;

  const { T = 0, S = 0, W = 0 } = integ;
  let raw = 100 + 10 * T + Math.round(2 * W + S);

  if (!Number.isFinite(raw)) return null;
  if (raw > MAX_SCORE) {
    raw = MAX_SCORE;
    world.flags = world.flags || {};
    world.flags.scoreMaxed = true;
  }
  return raw;
}

function applyDifficulty(world, POL) {
  world.globals ||= {};
  Object.assign(world.globals, {
    shockMul: POL.shockMul, volMul: POL.volMul, turnYears: POL.turnYears, substeps: POL.substeps, difficulty: POL.name
  });
}
const EMOJI_A=["🏔","🧩","🌋","💎","💐","🌳","🦏","🪵","🦊","🐠","🌸","🌵","🪐"];
const EMOJI_B=["🪵","💎","🌋","🫘","🪱","🌳","🧩","📡","🪼","🦜","🌸","🌵","🪲"];
const hashBytes = input => Array.from(createHash("sha256").update(input).digest());
function emojiNameVariant(seed, index, attempt) {
  const bytes = hashBytes(`${seed}:${index}:${attempt}`);
  const a = EMOJI_A[bytes[1] % EMOJI_A.length], b = EMOJI_B[bytes[2] % EMOJI_B.length];
  const flip = (bytes[3] & 1) === 1;
  let name = flip ? `${b}${a} ` : `${a}${b} `;
  if (attempt >= 4) name += ["·","•","⁑","⁂","⁎","⁘","⁙","⁛"][bytes[4] % 8];
  return name;
}
async function ensureEmojiNames(redis, seed, world) {
  const regs = world?.regimes || []; if (!regs.length) return;
  const taken = new Set();
  for (const R of regs) if (R?.name && !/^R\d+$/i.test(R.name)) taken.add(normKey(R.name));
  for (let i=0;i<regs.length;i++){
    const R = regs[i] ||= {};
    if (!R.id) R.id = `ID${i.toString(36)}_${Date.now().toString(36)}`;
    let assign = !R.name || /^R\d+$/i.test(R.name) || taken.has(normKey(R.name));
    if (assign) {
      let attempt=0, candidate;
      do { candidate = emojiNameVariant(seed, i, attempt++); } while (taken.has(normKey(candidate)) && attempt<12);
      if (taken.has(normKey(candidate))) candidate += i;
      R.name = candidate;
    }
    taken.add(normKey(R.name));
  }
  rebuildAliases(world);
  await redis.set(`${simKey}${seed}`, JSON.stringify(world));
}
function rebuildAliases(world){
  world._nameAliases = {}; world._idToIndex = {};
  const regs = world?.regimes || [];
  for (let i=0;i<regs.length;i++){
    const R = regs[i] || {};
    world._nameAliases[normKey(R.name || `R${i}`)] = i;
    if (R.id) world._idToIndex[R.id] = i;
  }
}
const isAlive = R => !!(R && (typeof R.alive==="boolean" ? R.alive : (typeof R.dead==="boolean" ? !R.dead : true)));
const aliveCount = world => (world?.regimes||[]).reduce((a,R)=>a+(isAlive(R)?1:0),0);
const regimeName = (world,i)=> world?.regimes?.[i]?.name || `R${i}`;

function humansMap(world){ world.humans ||= {}; return world.humans; }
function humanControlledIndex(world, sub){ const m=humansMap(world), rec=m[sub]; if (!rec) return null; const R=world.regimes?.[rec.idx]; return (R && isAlive(R)) ? rec.idx : null; }

function vOrLow(x, low=0.22) { const n = Number(x); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : low; }
function present(v) { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null; }
function survivalScore(R) {
  const S  = vOrLow(R?.stability, 0.18);
  const A  = vOrLow(R?.approval,  0.22);
  const W  = vOrLow(R?.wealth,    0.20);
  const U  = vOrLow(R?.unrest,    0.40);
  const LQ = vOrLow(R?.liquidity, 0.20);
  const FX = vOrLow(R?.fxReserves,0.20);
  let score = 0.34*S + 0.22*A + 0.16*W + 0.12*LQ + 0.08*FX - 0.22*U;
  return clamp(score, 0, 1);
}
function fatalFlags(R, trailMin) {
  const S  = present(R?.stability);
  const A  = present(R?.approval);
  const U  = present(R?.unrest);
  const LQ = present(R?.liquidity);
  const FX = present(R?.fxReserves);
  const D  = present(R?.debtRatio);
  const FInv = present(R?.market?.F?.Inv ?? R?.market?.Food?.Inv);
  const GInv = present(R?.market?.G?.Inv ?? R?.market?.Goods?.Inv);
  const FMin = trailMin?.F ?? FInv ?? 1;
  const GMin = trailMin?.G ?? GInv ?? 1;
  const bankrupt    = (LQ!==null && FX!==null && D!==null) && (LQ<COLLAPSE.BANK_LQFX && FX<COLLAPSE.BANK_LQFX && D>COLLAPSE.BANK_DEBT);
  const famine      = (FMin < COLLAPSE.FAMINE_MIN && GMin < COLLAPSE.FAMINE_MIN);
  const revolt      = (U!==null && A!==null) && (U>COLLAPSE.REVOLT_U && A<COLLAPSE.REVOLT_A);
  const collapseNow = (S!==null && A!==null) && (S<COLLAPSE.INSTANT_S && A<COLLAPSE.INSTANT_A);
  return { bankrupt, famine, revolt, collapseNow };
}
function ensureTrails(world, len=3) {
  const regs = world?.regimes || [];
  world._vitalsTrail = world._vitalsTrail || {};
  for (let i=0;i<regs.length;i++){
    const R = regs[i] || {};
    const F = vOrLow(R?.market?.F?.Inv ?? R?.market?.Food?.Inv, 0.08);
    const G = vOrLow(R?.market?.G?.Inv ?? R?.market?.Goods?.Inv, 0.08);
    const t = world._vitalsTrail[i] || {F:[],G:[]};
    t.F.push(F); t.G.push(G);
    if (t.F.length > len) t.F.shift();
    if (t.G.length > len) t.G.shift();
    world._vitalsTrail[i] = t;
  }
}
function evaluateCollapse(world) {
  const regs = world?.regimes || [];
  const N = regs.length;
  const prevDC = Array.isArray(world._deathCounter) ? world._deathCounter : [];
  world._deathCounter = Array.from({ length: N }, (_, i) => prevDC[i] ?? 0);
  ensureTrails(world, 3);
  const joinMap = world._joinStepForIndex || {};
  for (let i = 0; i < N; i++) {
    const R = regs[i];
    if (!isAlive(R)) continue;
    const t = world._vitalsTrail?.[i];
    const trailMin = { F: Math.min(...(t?.F?.length ? t.F : [1])), G: Math.min(...(t?.G?.length ? t.G : [1])) };
    const h = survivalScore(R);
    const { bankrupt, famine, revolt, collapseNow } = fatalFlags(R, trailMin);
    const critical = (h < COLLAPSE.HEALTH) || bankrupt || famine || revolt || collapseNow;
    const isHuman = !!R?.ctrl;
    const joinedAt = Number(joinMap[String(i)] ?? NaN);
    const inGrace = isHuman && Number.isFinite(joinedAt) ? ((world.step | 0) - joinedAt) < COLLAPSE.GRACE_STEPS : false;
    const prev = Number(world._deathCounter[i] || 0);
    const next = critical ? prev + 1 : Math.max(0, prev - 1);
    world._deathCounter[i] = next;
    const needed = isHuman ? COLLAPSE.HUMAN_HYST : COLLAPSE.NPC_HYST;
    if (collapseNow && !inGrace) {
      R.alive = false; R.dead = true;
      world.conflictLog = world.conflictLog || [];
      world.conflictLog.push({ t: Date.now(), from: regimeName(world, i), to: regimeName(world, i), kind: "collapse" });
      continue;
    }
    if (!inGrace && next >= needed) {
      R.alive = false; R.dead = true;
      world.conflictLog = world.conflictLog || [];
      world.conflictLog.push({ t: Date.now(), from: regimeName(world, i), to: regimeName(world, i), kind: "collapse" });
    }
  }
}

async function seedRegimes(redis, howMany, POL){
  const started = await startGame(redis, { nR: Math.max(howMany,2), select:"rand", difficulty: POL.name });
  return (started.world?.regimes || []).slice(0, howMany);
}
async function spawnNPCs(redis, world, need, POL){
  if (need<=0) return 0;
  const regs = world.regimes || (world.regimes=[]);
  const seed = await seedRegimes(redis, need, POL);
  const base = regs.length;
  for (let i=0;i<seed.length;i++){
    const R = JSON.parse(JSON.stringify(seed[i] || {}));
    R.id = `NPC_${Date.now().toString(36)}_${i.toString(36)}_${Math.random().toString(36).slice(2,6)}`;
    R.name = emojiNameVariant(GLOBAL_GAME_ID, base+i, 0);
    R.alive = true; R.dead = false; R.ctrl = null;
    regs.push(R);
  }
  rebuildAliases(world);
  return seed.length;
}
async function enforceSeats(redis, world, POL){
  const need = Math.max(0, MIN_SEATS - aliveCount(world));
  if (need>0) await spawnNPCs(redis, world, need, POL);
}

function addEdge(set,a,b){ if(a==null||b==null||a===b) return; const A=Math.min(a,b),B=Math.max(a,b); set.add(`${A}-${B}`); }
function indexForName(world,v){
  const regs = world?.regimes || []; const n=regs.length;
  if (v==null||!n) return null;
  if (typeof v==="number" && Number.isFinite(v)) return (v>=0 && v<n)?v:null;
  if (typeof v==="string" && world?._idToIndex && world._idToIndex[v]!=null) return world._idToIndex[v];
  const s = String(v).normalize("NFKC").replace(/[\uFE0E\uFE0F\u200D\u200C]/g,"").trim().replace(/\s+/g," ");
  if (/^\d+$/.test(s)){ const k=Number(s); return (k>=0 && k<n)?k:null; }
  const map = world?._nameAliases || {}; return (s in map)?map[s]:null;
}
function collectAllianceEdges(world){
  rebuildAliases(world);
  const edges=new Set(), toIdx=v=>indexForName(world,v);
  const dl = world?.diplomacy?.alliances ?? world?.alliances;
  if (Array.isArray(dl)){
    for (const e of dl){
      if (Array.isArray(e)) {
        if (e.length===2) addEdge(edges, toIdx(e[0]), toIdx(e[1]));
        else {
          const idxs=e.map(toIdx).filter(x=>x!=null);
          for(let i=0;i<idxs.length;i++) for(let j=i+1;j<idxs.length;j++) addEdge(edges, idxs[i], idxs[j]);
        }
      } else if (e && typeof e==="object"){
        if (Array.isArray(e.members)){
          const idxs=e.members.map(toIdx).filter(x=>x!=null);
          for(let i=0;i<idxs.length;i++) for(let j=i+1;j<idxs.length;j++) addEdge(edges, idxs[i], idxs[j]);
        } else addEdge(edges, toIdx(e.a ?? e.i ?? e.from ?? e.u ?? e[0]), toIdx(e.b ?? e.j ?? e.to ?? e.v ?? e[1]));
      }
    }
  }
  const regs=world?.regimes||[];
  regs.forEach((R,i)=>{
    const allies=R?.allies;
    if (Array.isArray(allies)) allies.forEach(v=>addEdge(edges,i,toIdx(v)));
    else if (allies && typeof allies==="object") Object.keys(allies).forEach(k=>addEdge(edges,i,toIdx(k)));
  });
  const rel = world?.diplomacy?.relations ?? world?.relations;
  const thr = Number(world?.diplomacy?.allyThreshold ?? world?.globals?.allyThreshold ?? 0.75);
  if (Array.isArray(rel) && rel.length===regs.length && rel.every(row=>Array.isArray(row)&&row.length===regs.length)){
    for (let i=0;i<regs.length;i++) for(let j=i+1;j<regs.length;j++){
      const v = Number(rel[i][j]); if (Number.isFinite(v) && v>=thr) addEdge(edges,i,j);
    }
  }
  return edges;
}
function collectConflictEdges(world, maxEvents=20){
  rebuildAliases(world);
  const edges=new Set(), toIdx=v=>indexForName(world,v);
  const all = Array.isArray(world?.conflictLog)&&world.conflictLog.length ? world.conflictLog : (Array.isArray(world?.conflicts)?world.conflicts:[]);
  const recent = (maxEvents===Infinity)?all:all.slice(-maxEvents);
  for (const e of recent) addEdge(edges, toIdx(e.from), toIdx(e.to));
  return edges;
}
const edgesToPairs = (edges, world)=> {
  const regs=world?.regimes||[], out=[];
  for (const key of edges){ const m=/^(\d+)-(\d+)$/.exec(key); if(!m) continue; const a=+m[1], b=+m[2]; if (isAlive(regs[a])&&isAlive(regs[b])) out.push([a,b]); }
  out.sort((x,y)=>x[0]-y[0]||x[1]-y[1]); return out;
};
const pairsPretty = (world,pairs)=> pairs.map(([a,b])=>`${regimeName(world,a)}–${regimeName(world,b)}`);

function currentYear(world){ const G=world.globals||{}; const dtY=Math.max(0.25,Number(G.turnYears||1)); return Math.floor(START_YEAR + (world.step*dtY)); }
function endedRegimes(before,after){
  const A=before?.regimes||[], B=after?.regimes||[], out=[];
  for (let i=0;i<Math.max(A.length,B.length);i++){ if (isAlive(A[i]) && !isAlive(B[i])) out.push(i); }
  return out;
}
function makeTurnNarrative({worldBefore, worldAfter, phasesSeen}){
  const lines=[];
  const dead=endedRegimes(worldBefore, worldAfter);
  if (dead.length) lines.push(`· Regime(s) ended: ${dead.map(i=>regimeName(worldAfter,i)).join(", ")}.`);
  let k=0; for (const label of phasesSeen){ k++; if (k%2===0){ const line=makeNarrativeForPhase(NARR, label, worldAfter); if (line) lines.push(`· ${line}`); } }
  if (!lines.length) lines.push(`[${currentYear(worldAfter)}] · Quiet turn.`);
  return lines;
}
function moodsLine(world, prev=null){
  const regs=world?.regimes||[]; if (!regs.length) return "";
  const met=[["stability",0],["order",0],["inclusion",0],["liquidity",0],["fxReserves",0],["debtRatio",1],["unrest",1],["growth",0],["inflation",1],["unemployment",1],["approval",0]];
  const val = x => { const v=Number(x); return Number.isFinite(v)?v:null; };
  const bounds=(k)=>{ let lo=+Infinity,hi=-Infinity,c=0; for(const R of regs){ const v=val(R?.[k]); if(v!==null){c++; if(v<lo)lo=v; if(v>hi)hi=v; }} return c>=2?[lo,hi]:null; };
  const norm=(k,v,inv)=>{ if(v===null) return null; const bh=bounds(k); if(!bh) return null; const [lo,hi]=bh; if(hi<=lo) return 0.5; let t=(v-lo)/(hi-lo); if(inv) t=1-t; return clamp(t,0,1); };
  const typeCode = R => { const c=(R?.type||R?.code||R?.regime||"").toString().toUpperCase(); if(/^[NDAT]$/.test(c)) return c; const o=Number(R?.order??0.5), i=Number(R?.inclusion??0.5); return o>=0.5?(i>=0.5?"D":"T"):(i>=0.5?"N":"A"); };
  const rows=regs.map((R,i)=>{
    const parts=[]; for(const [k,inv] of met){ const u=norm(k,val(R?.[k]),!!inv); if(u!==null) parts.push(u); }
    const prior={D:0.65,N:0.55,T:0.52,A:0.45}[typeCode(R)] ?? 0.5;
    const level=parts.length?(0.9*(parts.reduce((a,b)=>a+b,0)/parts.length)+0.1*prior):prior;
    const pr=prev?.regimes?.[i]; const dz=(k)=>{ const a=val(R?.[k]), b=val(pr?.[k]); return (a==null||b==null)?0:a-b; };
    const mom=0.06*Math.tanh(dz("stability")*6)+0.05*Math.tanh(dz("liquidity")*6)+0.05*(-Math.tanh(dz("unrest")*6))+0.03*Math.tanh(dz("growth")*3)+0.03*(-Math.tanh(dz("inflation")*3));
    const raw=clamp(level+mom+(Math.random()-0.5)*0.04,0,1);
    return {i, raw};
  });
  const sorted=[...rows].sort((a,b)=>a.raw-b.raw), rank=new Map(sorted.map((r,j)=>[r.i,j]));
  const label=q=> q<=0.15?"Panicked":q<=0.40?"Unstable":q<=0.60?"Tense":q<=0.85?"Calm":"Confident";
  return rows.map(r=>label((regs.length===1)?0.5:(rank.get(r.i)/(regs.length-1)))).map((m,i)=>`${regimeName(world,i)}:${m}`).join("  |  ");
}
function enhanceSnapshot(base, world, prev=null){
  const filtered = String(base??"").split(/\r?\n/).filter(l=>!/^Alliances:|^Conflicts:/i.test(l.trim()));
  const allies = edgesToPairs(collectAllianceEdges(world), world);
  const conflicts = edgesToPairs(collectConflictEdges(world,20), world);
  const out = [...filtered];
  out.push(`Alliances: ${allies.length}`); if (allies.length) out.push(pairsPretty(world, allies).join(" | "));
  out.push(`Conflicts: ${conflicts.length}`); if (conflicts.length) out.push(pairsPretty(world, conflicts).join(" | "));
  const ml = moodsLine(world, prev); if (ml) out.push(`Mood: ${ml}`);
  return out.join("\n");
}
function markYourRegime(snapshot, myIdx) {
  try {
    if (myIdx == null || !snapshot) return snapshot;
    const lines = String(snapshot).split(/\r?\n/);

    const ESC = String.raw`\x1b\[[0-9;]*m`;
    const ROW  = new RegExp(`^\\s{2,}(?:${ESC})*(?:\\*\\s+|\\s{0,2})?\\p{Extended_Pictographic}`, "u");
    const PREF = new RegExp(`^(\\s{2,})((?:${ESC})*)(?:\\*\\s+|\\s{0,2})?`);

    const isRow = (L) => ROW.test(L);

    function markSection(start, end) {
      const rows = [];
      for (let i = start; i < end; i++) if (isRow(lines[i])) rows.push(i);

      if (!rows.length) return;
      const k = Math.max(0, Math.min(myIdx, rows.length - 1));

      rows.forEach((ri, idx) => {
        const flag = idx === k ? "* " : "  ";
        lines[ri] = lines[ri].replace(PREF, (_, indent, ansi) => indent + ansi + flag);
      });
    }

    const fundHdr = lines.findIndex(l => /^\s*FUNDAMENTALS\b/i.test(l));
    const mktHdr  = lines.findIndex(l => /^\s*MARKETS\b/i.test(l));
    const endFund = mktHdr === -1 ? lines.length : mktHdr;
    const endMkt  = lines.length;

    if (fundHdr !== -1) markSection(fundHdr, endFund);
    if (mktHdr  !== -1) markSection(mktHdr, endMkt);

    let out = lines.join("\n");
    if (!/\(\*\)\s*=\s*your regime/i.test(out)) {
      out = out.replace(/^\s*FUNDAMENTALS\b/im, "\n(*) = your regime\n\nFUNDAMENTALS");
    }
    return out;
  } catch {
    return snapshot;
  }
}

function ensureMeters(world){ world.playerMeters ||= {}; }

function regenMetersFor(world, sub){
  ensureMeters(world);
  const i=humanControlledIndex(world, sub); if (i==null) return;
  const me=world.regimes?.[i]; if (!me) return;
  const S=Number(me.stability||0.5), A=Number(me.approval||0.5), W=Number(me.wealth||0.5), FX=Number(me.fxReserves||0.5);
  const M=(world.playerMeters[sub] ||= { PC:1.0, HC:1.0, HEAT:0 });
  M.PC=Math.min(5, M.PC + 0.10*(0.6*S+0.4*A));
  M.HC=Math.min(5, M.HC + 0.10*(0.7*W+0.3*FX));
  const heatDecay=0.05*(1 + (me?.policies?.counterintel?0.5:0));
  M.HEAT=Math.max(0, M.HEAT - heatDecay);
}

function detectionChance(world, attacker, defender, x, opts){
  const PS = Number(defender?.externals?.PS ?? defender?.stability ?? 0.5);
  const RA = Number(world?.globals?.RA ?? 0.0);
  const HEAT = Number(opts?.HEAT ?? 0);
  const stealth = !!opts?.stealth;
  let p = 0.10 + 0.60*PS + 0.20*RA + 0.10*(HEAT/4);
  if (stealth) p *= 0.65;
  p = clamp(p, 0.02, 0.95);
  p = clamp(p + 0.5*x, 0.02, 0.98);
  if (defender?.policies?.counterintel) p = clamp(p*1.15, 0.02, 0.98);
  return p;
}

function applyPlayerActs(world, acts, sub){
  if (!world || !Array.isArray(acts) || !acts.length || !sub) return { applied:0 };
  rebuildAliases(world); ensureMeters(world);
  const meIdx = humanControlledIndex(world, sub); if (meIdx==null) return { applied:0 };
  const regs=world.regimes||[], me=regs[meIdx]; if(!me) return { applied:0 };
  const meters=(world.playerMeters[sub] ||= {PC:1.0, HC:1.0, HEAT:0}); let {PC,HC,HEAT}=meters;
  me.policies ||= {};

  const heatMul=1+0.25*HEAT, stepCost=(base,dv)=>{ const u=Math.abs(dv)/0.01; return heatMul*base*(u+0.15*u*u); };

  const doBoost=a=>{
    const ps=num(a.ps,0,0.03,0), ta=num(a.ta,0,0.03,0), ea=num(a.ea,0,0.03,0), inv=num(a.investI,0,0.12,0);
    const cPC=stepCost(1.0,ps)+stepCost(1.5,ta)+stepCost(1.2,ea), cHC=stepCost(0.8,inv);
    if (PC<cPC || HC<cHC) return false;

    me.externals ||= {};
    me.market ||= {}; me.market.I ||= {Inv:1};
    me.externals.PS=clamp((me.externals.PS??0.5)+ps,0.01,1);

    const taEff = (a.policy==="price_stability") ? ta*0.9 : ta;
    me.externals.TA=clamp((me.externals.TA??0.5)+taEff,0,1);
    me.externals.EA=clamp((me.externals.EA??0.5)+ea,0,1);
    me.market.I.Inv=clamp((me.market.I.Inv??1)+inv,0.1,3.0);

    if (a.policy==="counterintel") me.policies.counterintel = true;
    if (a.policy==="food_security") {
      me.market.F ||= {Inv:1}; me.market.F.Inv = clamp(me.market.F.Inv + inv*0.25 + 0.02, 0.01, 2.5);
    }
    if (a.policy==="price_stability") {
      HEAT = Math.max(0, HEAT - 0.1);
      me.externals.PS = clamp(me.externals.PS + 0.005, 0.01, 1);
    }

    const f = String(a.focus||"").toLowerCase();
    if (f==="industry") {
      me.market.G ||= {Inv:1}; me.market.I ||= {Inv:1};
      me.market.I.Inv  = clamp(me.market.I.Inv + 0.02, 0.1, 3.0);
      me.market.G.Inv = clamp(me.market.G.Inv + 0.02, 0.1, 2.5);
      me.market.F ||= {Inv:1}; me.market.F.Inv = clamp(me.market.F.Inv - 0.01, 0.01, 2.5);
    } else if (f==="services") {
      me.externals.EA = clamp(me.externals.EA + 0.01, 0.01, 1);
      me.market.G ||= {Inv:1}; me.market.G.Inv = clamp(me.market.G.Inv + 0.015, 0.1, 2.5);
    } else if (f==="agri") {
      me.market.F ||= {Inv:1}; me.market.F.Inv = clamp(me.market.F.Inv + 0.03, 0.01, 2.5);
    }

    PC-=cPC; HC-=cHC; return true;
  };

  const doTrade=a=>{
    const to=indexForName(world,a.to); if(to==null||to===meIdx) return false; const you=regs[to]; if(!you||!isAlive(you)) return false;
    const cat=String(a.cat||"").trim().toUpperCase(); if(!me.market[cat]||!you.market[cat]) return false;
    const want=num(a.vol,0.01,0.6,0.1), maxSend=clamp(me.market[cat].Inv*0.25,0.01,0.6);
    let vol=Math.min(want,maxSend); if(vol<=1e-6) return false;

    const targetIsNPC = !you.ctrl;

    if (targetIsNPC) {
      const invY = Number(you.market[cat].Inv || 0.0);
      if (!(invY < 1.0)) return false;
      const npcQuota = clamp(Math.min(0.25, Math.max(0.05, 1.0 - invY)), 0.05, 0.25);
      vol = Math.min(vol, npcQuota);
      if (vol <= 1e-6) return false;

      world._npcTradeEpoch ||= {};
      const epochKey = `${currentEpoch()}:${sub}`;
      const spent = Number(world._npcTradeEpoch[epochKey] || 0);
      const left = clamp(0.60 - spent, 0, 0.60);
      if (left <= 1e-6) return false;
      vol = Math.min(vol, left);

      const cHC=stepCost(0.3,vol)*1.5; if(HC<cHC) return false;
      me.market[cat].Inv=Math.max(0.01, me.market[cat].Inv - vol);
      you.market[cat].Inv=clamp(you.market[cat].Inv + vol, 0.01, 2.5);

      me.externals.EA=clamp((me.externals.EA??0.5)+0.20*(0.5*vol*0.012),0.01,1);
      me.externals.PS=clamp((me.externals.PS??0.5)+0.20*(0.5*vol*0.0025),0.01,1);

      HC-=cHC; world._npcTradeEpoch[epochKey]=spent+vol;
      return true;
    }

    const cHC=stepCost(0.3,vol); if(HC<cHC) return false;
    me.market[cat].Inv=Math.max(0.01, me.market[cat].Inv - vol);
    you.market[cat].Inv=clamp(you.market[cat].Inv + vol, 0.01, 2.5);

    me.externals.EA=clamp((me.externals.EA??0.5)+0.5*vol*0.012,0.01,1);
    you.externals.EA=clamp((you.externals.EA??0.5)+0.5*vol*0.017,0.01,1);
    me.externals.PS=clamp((me.externals.PS??0.5)+0.5*vol*0.0025,0.01,1);
    you.externals.PS=clamp((you.externals.PS??0.5)+0.5*vol*0.0035,0.01,1);

    HC-=cHC; return true;
  };

  const doCovert=a=>{
    const to=indexForName(world,a.to); if(to==null||to===meIdx) return false; const you=regs[to]; if(!you||!isAlive(you)) return false;
    const kind=String(a.kind||"destabilize").toLowerCase(), x=num(a.x,0.001,0.02,0.005);
    const stealth = !!a.stealth;
    const base=(kind==="steal_tech"?3.0:2.0)*(stealth?1.25:1.0);
    const cPC=stepCost(base,x); if (PC<cPC) return false;

    const detectP = detectionChance(world, me, you, x, { HEAT, stealth });
    const detected = Math.random() < detectP;

    if (kind==="destabilize") {
      you.externals ||= {};
      you.externals.PS=clamp((you.externals.PS??0.5) - x, 0.01, 1);
      if (detected) {
        you.externals.PS = clamp(you.externals.PS + 0.5*x, 0.01, 1);
        HEAT = Math.min(4.0, HEAT + 0.35*(x/0.01));
        world.conflictLog = world.conflictLog || [];
        world.conflictLog.push({t:Date.now(), from:regimeName(world,meIdx), to:regimeName(world,to), kind:"covert_exposed"});
      }
    } else {
      you.externals ||= {}; me.externals ||= {};
      const d=x*0.6;
      you.externals.TA=clamp((you.externals.TA??0.5)-d,0,1);
      me.externals.TA=clamp((me.externals.TA??0.5)+d*(detected?0.4:0.6),0,1);
      if (detected) {
        HEAT = Math.min(4.0, HEAT + 0.25*(x/0.01));
        you.externals.PS = clamp((you.externals.PS??0.5) + 0.25*x, 0.01, 1);
        world.conflictLog = world.conflictLog || [];
        world.conflictLog.push({t:Date.now(), from:regimeName(world,meIdx), to:regimeName(world,to), kind:"covert_exposed"});
      }
    }

    world.globals.RA=clamp((world.globals.RA??0) + 0.02*(x/0.01), -0.5, 1.0);

    HEAT=Math.min(4.0, HEAT + (stealth?0.16:0.20)*(x/0.01));
    PC-=cPC; return true;
  };

  let applied=0;
  for (const act of acts.slice(0,8)){ if(!act) continue;
    const t=String(act.type||"").toLowerCase();
    const ok = t==="boost"?doBoost(act) : t==="trade"?doTrade(act) : t==="covert"?doCovert(act) : false;
    if (ok) applied++;
  }
  meters.PC=clamp(PC,0,5); meters.HC=clamp(HC,0,5); meters.HEAT=clamp(HEAT,0,4);
  return { applied, meters:{...meters} };
}

function finalPayload({ token, step, policy, snapshot, narrative, trophy, score, meters, board, best, rank }){
  const base = { ok:true, token, step, policy, done:false, snapshot, narrative };
  if (trophy) base.trophy=trophy;
  if (Number.isFinite(score)) base.score=score;
  if (meters) base.meters=meters;
  if (board)  base.board=board;
  if (Number.isFinite(best)) base.best = best;
  if (Number.isFinite(rank)) base.rank = rank;
  return base;
}

function scoreKeyForIndex(world, idx){
  const R = world?.regimes?.[idx];
  if (!R) return null;
  return R.ctrl || R.id || `IDX${idx}`;
}

function accrueTurnForAll(world){
  world._integrals ||= {};
  const regs = world?.regimes || [];
  for (let i=0;i<regs.length;i++){
    const R = regs[i];
    if (!isAlive(R)) continue;
    const key = scoreKeyForIndex(world, i);
    if (!key) continue;
    const K = (world._integrals[key] ||= { S:0, W:0, T:0 });
    K.S += Number(R?.stability || 0);
    K.W += Number(R?.wealth    || 0);
    K.T += 1;
  }
}

async function submitScore(redis, { mode, epoch, world, winnerSub }) {
  world._integrals ||= {};
  const K = world._integrals[winnerSub];
  if (!K) return null;

  const T = Number(K.T ?? (world.step | 0));
  const Ssum = Number(K.S ?? 0);
  const Wsum = Number(K.W ?? 0);
  const raw0 = 100 + 10 * T + Math.round(2 * Wsum + Ssum);
  const raw  = Math.min(raw0, MAX_SCORE);
  
  const boardKey = `sim:board:${mode}:${epoch}`;
  const entryKey = `sim:entry:${mode}:${epoch}:${winnerSub}`;

  let oldScore = await redis.zScore(boardKey, winnerSub);
  if (oldScore == null || raw > oldScore) {
    await redis.zAdd(boardKey, [{ score: raw, value: winnerSub }]);

    const payload = {
      ok: true,
      v: 2,
      mode,
      epoch,
      game: GLOBAL_GAME_ID,
      sub: winnerSub,
      step: world.step | 0,
      turns: T,
      sums: { W: Wsum, S: Ssum },
      score: raw,
      when: Date.now()
    };

    await redis.set(entryKey, JSON.stringify(payload), { EX: SCORE_TTL });
    await redis.expire(boardKey, SCORE_TTL);

    oldScore = raw;
  } else {
    await redis.expire(boardKey, SCORE_TTL);
    await redis.expire(entryKey, SCORE_TTL);
  }

  const rankIdx = await redis.zRevRank(boardKey, winnerSub);
  let top = [];
  try {
    const topPairs = await redis.zRange(boardKey, 0, 9, { REV: true, WITHSCORES: true });
    for (let i = 0; i < topPairs.length; i += 2) {
      top.push({ sub: topPairs[i], score: Number(topPairs[i + 1]) });
    }
  } catch (e) {
    try {
      const rows = await redis.zRevRangeWithScores?.(boardKey, 0, 9);
      if (Array.isArray(rows)) {
        top = rows.map(r => ({ sub: r.value, score: Number(r.score) }));
      }
    } catch (_e) { }
  }

  return {
    score: Number(oldScore),
    rank: rankIdx != null ? rankIdx + 1 : null,
    top
  };
}

async function loadOrBootShard(POL){
  let world = await loadWorld(r, GLOBAL_GAME_ID);
  if (!world) {
    const started = await startGame(r, { nR: MIN_SEATS, select:"rand", difficulty: POL.name });
    world = started.world;
  }
  applyDifficulty(world, POL);
  await ensureEmojiNames(r, GLOBAL_GAME_ID, world);
  return world;
}
async function hardResetShard(POL){
  const started = await startGame(r, { nR: MIN_SEATS, select:"rand", difficulty: POL.name });
  const world = started.world;
  world.humans = {}; world.playerMeters = {}; world._integrals = {};
  applyDifficulty(world, POL); await ensureEmojiNames(r, GLOBAL_GAME_ID, world); await saveWorld(r, GLOBAL_GAME_ID, world);
  return world;
}
async function reseedNPCsKeepHumans(POL){
  let world = await loadWorld(r, GLOBAL_GAME_ID); if (!world) return hardResetShard(POL);
  const regs=world.regimes||[], map=humansMap(world), keep=[], remap=new Map();
  for (let i=0;i<regs.length;i++){ const R=regs[i]; if (!R) continue; if (isAlive(R)) { remap.set(i, keep.length); keep.push(R); } }
  world.regimes = keep;
  for (const [sub,rec] of Object.entries(map)){ if(rec && remap.has(rec.idx)) rec.idx=remap.get(rec.idx); else delete map[sub]; }
  await enforceSeats(r, world, POLICY_ENV || MIN); await ensureEmojiNames(r, GLOBAL_GAME_ID, world); await saveWorld(r, GLOBAL_GAME_ID, world);
  return world;
}

http.createServer(async (req, res) => {
  const POL = policyFromReq(req); setSecureHeaders(res, POL.name);
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method==="GET" && url.pathname==="/") {
    return text(res, 200,
`GLOBAL SHARD — one persistent world (never ends)

GET  /status       — join/inspect the shard; allocates a seat if available
POST /move         — advance one turn. Body: {"token":"...", "acts":[...]}
GET  /scoreboard   — leaderboard: ?epoch=<int>&mode=MIN|MAX (mode optional)

Actions:
  boost : {ps, ta, ea, investI, policy?, focus?}
          policy = counterintel | price_stability | food_security
          focus  = industry | services | agri
  trade : {to, cat, vol}   (NPCs allowed with guardrails)
  covert: {to, kind, x, stealth?}    kind = destabilize | steal_tech`);
  }

  if (req.method==="POST" && (url.pathname==="/admin/reset" || url.pathname==="/admin/reseed")) {
    if (!ADMIN_KEY || req.headers["x-admin-key"] !== ADMIN_KEY) return json(res, 403, { ok:false, err:"forbidden" });
    if (url.pathname==="/admin/reset") { await hardResetShard(POL); return json(res, 200, { ok:true, msg:"hard_reset" }); }
    await reseedNPCsKeepHumans(POL); return json(res, 200, { ok:true, msg:"reseed_npcs" });
  }

  if (req.method==="GET" && url.pathname==="/status") {
    if (!(await rateGate("status", req, res, POL))) return;
    let world = await loadOrBootShard(POL);
    await enforceSeats(r, world, POL);

    const tokIn = extractToken(req, url), p = verifyTok(tokIn || "");
    const sub = p?.sub || ipHash(req);
    const map = humansMap(world);
    let myIdx = humanControlledIndex(world, sub);

    if (myIdx == null) {
      const regs=world.regimes||[];
      let found=null;
      const taken = new Set(Object.values(map).map(v=>v?.idx));
      for (let i=0;i<regs.length;i++){ const R=regs[i]; if (isAlive(R) && !taken.has(i) && !R.ctrl) { found=i; break; } }
      if (found==null) {
        if (aliveCount(world) >= MAX_SEATS) return json(res, 410, { ok:false, err:"seat_full", msg:`Max seats (${MAX_SEATS}) reached. Try again later.` });
        await spawnNPCs(r, world, 1, POL); found = world.regimes.length-1;
      }
      map[sub] = { idx: found, joinedAt: Date.now(), lastActive: Date.now() };
      world._integrals ||= {};
      world._integrals[sub] = { S: 0, W: 0, T: 0 };
      world._joinStepForIndex = world._joinStepForIndex || {};
      world._joinStepForIndex[String(found)] = world.step | 0;
      world.regimes[found].ctrl = sub; myIdx = found;
      await ensureEmojiNames(r, GLOBAL_GAME_ID, world);
      await saveWorld(r, GLOBAL_GAME_ID, world);
    } else {
      map[sub].lastActive = Date.now();
      await saveWorld(r, GLOBAL_GAME_ID, world);
    }

    const token = sign({ iss:"sim", mode:"SIM", exp: now()+POL.token_ttl, step: world.step|0, game: GLOBAL_GAME_ID, pol: POL.name, sub });
    let snap = enhanceSnapshot(worldSnapshot(world), world, null);
    snap = markYourRegime(snap, myIdx);
    return json(res, 200, { ok:true, mode:"SIM", policy: POL.name, token, step: world.step|0, game: GLOBAL_GAME_ID, you:{sub, idx:myIdx}, done:false, snapshot: snap, narrative: [] });
  }

  if (req.method==="GET" && url.pathname==="/scoreboard") {
    if (!(await rateGate("scoreboard", req, res, POL))) return;
    const epoch = url.searchParams.get("epoch") ? Number(url.searchParams.get("epoch")) : currentEpoch();
    const mode  = (url.searchParams.get("mode") || POL.name || "MIN").toUpperCase();
    if (!Number.isFinite(epoch)) return json(res, 400, { ok:false, err:"epoch_required" });

    const key = `sim:board:${mode}:${epoch}`;
    let rows=[];
    try {
      if (r.zRevRangeWithScores) rows = await r.zRevRangeWithScores(key, 0, 19);
      else {
        const raw = await r.zRange(key, 0, 19, { REV:true, WITHSCORES:true });
        for (let i=0;i<raw.length;i+=2) rows.push({ value: raw[i], score: Number(raw[i+1]) });
      }
    } catch (e) { return json(res, 500, { ok:false, err:String(e?.message||e) }); }

    const out=[];
    for (const row of rows){
      const sub=row.value ?? row.member ?? row[0] ?? row[1];
      const entry=await r.get(`sim:entry:${mode}:${epoch}:${sub}`);
      out.push({ sub, score: row.score ?? null, entry: entry?JSON.parse(entry):null });
    }
    return json(res, 200, { ok:true, mode, epoch, top: out });
  }

  if (req.method === "POST" && url.pathname === "/move") {
    if (!(await rateGate("move", req, res, POL))) return;

    let parsed = {};
    try {
      parsed = safeParse(await readBody(req, POL.body_limit));
    } catch (e) {
      return json(res, 400, { ok: false, err: e?.message === "too_large" ? "too_large" : "bad_request" });
    }

    const p = verifyTok((parsed.token || extractToken(req, url)) || "");
    if (!p || p.mode !== "SIM") return json(res, 410, { ok: false, err: "bad_token" });
    if (now() > p.exp)         return json(res, 410, { ok: false, err: "expired" });
    const sub = p.sub || "";
    if (!sub)                  return json(res, 410, { ok: false, err: "no_sub" });

    let worldBefore = await loadOrBootShard(POL);
    await enforceSeats(r, worldBefore, POL);
    const idx = humanControlledIndex(worldBefore, sub);
    if (idx == null) {
      return json(res, 410, { ok: false, err: "lost_seat", msg: "Your regime has fallen; rejoin via /status to get a new seat.", retry: false });
    }
    if (idx != null && worldBefore?.regimes?.[idx]) {
      worldBefore.regimes[idx].ctrl = sub;
    }

    const lockKey = `move:lock:${sub}`;
    const lockVal = `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const gotLock = await r.set(lockKey, lockVal, { NX: true, EX: MOVE_LOCK_TTL_S });
    if (!gotLock) {
      return json(res, 409, { ok: false, err: "busy_try_again" });
    }

    try {
      const cdKey = `move:cooldown:${sub}`;
      const cdOK  = await r.set(cdKey, "1", { NX: true, PX: MOVE_COOLDOWN_MS });
      if (!cdOK) {
        const ttl = await r.pTTL(cdKey);
        return json(res, 429, { ok: false, err: "too_fast", retry_after_ms: Math.max(0, ttl ?? MOVE_COOLDOWN_MS) });
      }

      regenMetersFor(worldBefore, sub);
      const acts = Array.isArray(parsed.acts) ? parsed.acts.slice(0, 8) : [];
      let metersEcho = null;
      if (acts.length) {
        const info = applyPlayerActs(worldBefore, acts, sub);
        metersEcho = info?.meters || null;
        await saveWorld(r, GLOBAL_GAME_ID, worldBefore);
      }

      accrueTurnForAll(worldBefore);
      await saveWorld(r, GLOBAL_GAME_ID, worldBefore);

      const phases = [];
      try {
        const worldAfter = await stepGame(r, GLOBAL_GAME_ID, (_p, label) => { if (label) phases.push(label); });
        applyDifficulty(worldAfter, POL);
        await ensureEmojiNames(r, GLOBAL_GAME_ID, worldAfter);

        evaluateCollapse(worldAfter);
        await enforceSeats(r, worldAfter, POL);

        const roll = rollingScoreFor(worldAfter, sub);
        const bestNow = await submitScore(r, { mode: POL.name, epoch: currentEpoch(), world: worldAfter, winnerSub: sub });

        const fellIdxs = endedRegimes(worldBefore, worldAfter);
        let boardSnap;
        for (const i of fellIdxs) {
          const Rb = worldBefore?.regimes?.[i];
          if (!Rb) continue;
          const key = Rb.ctrl || Rb.id;
          if (!key) continue;
          try {
            const info = await submitScore(r, { mode: POL.name, epoch: currentEpoch(), world: worldAfter, winnerSub: key });
            if (Rb.ctrl === sub) {
              boardSnap = {
                mode: POL.name,
                epoch: currentEpoch(),
                your: { sub, score: info?.score ?? null, rank: info?.rank ?? null },
                top: info?.top ?? []
              };
            }
          } catch (e) {
            console.error("score submit", e?.message || e);
          }
        }

        await saveWorld(r, GLOBAL_GAME_ID, worldAfter);

        const narrative = makeTurnNarrative({ worldBefore, worldAfter, phasesSeen: phases });
        let snap = enhanceSnapshot(worldSnapshot(worldAfter), worldAfter, worldBefore);
        snap = markYourRegime(snap, idx);
        const youFell = fellIdxs.includes(idx);
        if (youFell) {
          worldAfter._integrals && delete worldAfter._integrals[sub];
          await saveWorld(r, GLOBAL_GAME_ID, worldAfter);
        }
        const token2 = sign({
          iss: "sim",
          mode: "SIM",
          exp: now() + POL.token_ttl,
          step: worldAfter.step | 0,
          game: GLOBAL_GAME_ID,
          pol: POL.name,
          sub
        });

        const payload = finalPayload({
          token: token2,
          step: worldAfter.step | 0,
          policy: POL.name,
          snapshot: snap,
          narrative,
          score: rollingScoreFor(worldAfter, sub),
          best: bestNow?.score ?? null,
          rank: bestNow?.rank ?? null,
          meters: metersEcho,
          board: boardSnap
        });

        if (youFell) {
          payload.done = true;
          payload.score_final = Number.isFinite(roll) ? roll : null;
          if (!payload.board && bestNow) {
            payload.board = { mode: POL.name, epoch: currentEpoch(), your: { sub, score: bestNow.score, rank: bestNow.rank }, top: bestNow.top ?? [] };
          }
        }

        payload.you = { sub, idx };
        return json(res, 200, payload);
      } catch (e) {
        return json(res, 500, { ok: false, err: String(e?.message || e) });
      }
    } finally {
      try { await r.del(lockKey); } catch {}
    }
  }

  return text(res, 404, "not found");
}).listen(PORT, () => {
  console.log(`Server started`);
});
