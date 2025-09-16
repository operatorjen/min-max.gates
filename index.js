import dotenv from "dotenv";
dotenv.config();

import http from "node:http";
import { createHmac, createHash, randomBytes, createPublicKey, verify as edVerify, timingSafeEqual } from "node:crypto";
import { createClient } from "redis";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRIZE_PATH = process.env.PRIZE_PATH || resolvePath(__dirname, "prize.json");

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const r = createClient({ url: REDIS_URL });
r.on("error", err => console.error("redis", err));
await r.connect();

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.SECRET || randomBytes(32).toString("hex");
const boardKey = (ep, mode) => `maze:board:${ep}:${mode}`;
const nowMs = () => Date.now();
const now = () => Math.floor(nowMs() / 1000);
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sha = (v) => createHash("sha256").update(v).digest("hex");
const hmac = (k, v) => createHmac("sha256", k).update(v).digest();
const ipHash = (req) => createHash("sha256").update(req.socket?.remoteAddress || "").digest("base64url").slice(0,16);
const extractToken = (req, url) => bearer(req) || url.searchParams.get("token") || "";

const RATES = {
  MIN: { start: 120, move: 600, submit: 60 }, 
  MAX: { start: 30, move: 60, submit: 20 },
};

const SECURE_HEADERS = {
  "X-Policy": null,
  "X-No-Cookies": "1",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-site",
  "Content-Security-Policy": "default-src 'none'"
};

function setSecureHeaders(res, policyName) {
  for (const [k,v] of Object.entries(SECURE_HEADERS)) res.setHeader(k, v ?? policyName);
}

export function getPrizeEmoji() {
  const choices = ['🌋','⛰️','❤️‍🔥','🌳','💐','〰️','🌞','🌜','🪐'];
  return choices[Math.floor(Math.random() * choices.length)];
}

async function getBoardTop(ep, mode, limit = 50, k = 1) {
  try {
    const rows = await r.zRevRangeWithScores(boardKey(ep, mode), 0, limit - 1);
    return rows
      .filter(row => Number(row.score) >= k)
      .map(row => ({ id: row.value, count: Number(row.score) }));
  } catch {
    const byMode = scoreboard.get(ep)?.get(mode) || new Map();
    return [...byMode.entries()]
      .filter(([_, c]) => c >= k)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, count]) => ({ id, count }));
  }
}

async function loadPrize(mode, vars = {}) {
  try {
    const raw = await readFile(PRIZE_PATH, "utf8");
    const data = JSON.parse(raw);
    let content = "";
    if (typeof data === "string") content = data;
    else if (Array.isArray(data)) content = data.join("\n");
    else if (data && typeof data === "object") {
      let picked = data[mode] ?? data.default ?? data["*"];
      if (Array.isArray(picked)) picked = picked.join("\n");
      content = typeof picked === "string" ? picked : JSON.stringify(picked ?? "", null, 2);
    }
    content = content.replace(/\$\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
    return content;
  } catch {
    return null;
  }
}

async function rateGate(scope, req, res, policy, redisClient) {
  const lim = RATES[policy.name]?.[scope];
  if (!lim || !redisClient?.isOpen) return true;
  try {
    const bucket = Math.floor(Date.now() / 60000);
    const key = `maze:rate:${policy.name}:${scope}:${ipHash(req)}:${bucket}`;
    const n = await redisClient.incr(key);
    if (n === 1) await redisClient.expire(key, 70);
    if (n > lim) {
      res.setHeader("Retry-After", "60");
      await redisClient.expire(key, 70);
      text(res, 429, "slow down");
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

const sign = (obj) => {
  const p = b64u(Buffer.from(JSON.stringify(obj)));
  return `${p}.${b64u(hmac(SECRET, p))}`;
};
const verifyTok = (tok) => {
  const i = tok?.lastIndexOf("."); if (i < 0) return null;
  const p = tok.slice(0, i), m = tok.slice(i + 1);
  const m2 = b64u(hmac(SECRET, p));
  if (m.length !== m2.length) return null;
  if (!timingSafeEqual(Buffer.from(m), Buffer.from(m2))) return null;
  try { return JSON.parse(Buffer.from(p, "base64url").toString("utf8")); } catch { return null; }
};

const MIN = { name: "MIN", steps: 4, ttl: 60, diff0: 3, diffStep: 0, bodyLimit: 32 * 1024 };
const MAX = { name: "MAX", steps: 6, ttl: 45, diff0: 4, diffStep: 0, bodyLimit: 8 * 1024 };
const policyFor = (host = "") => host.startsWith("max.") ? MAX : MIN;
const ENV_MODE = (process.env.DIFFICULTY_MODE || "").toUpperCase();
const ENV_POLICY = ENV_MODE === "MAX" ? MAX : (ENV_MODE === "MIN" ? MIN : null);
const policyFromReq = (req) => {
  const fwd = (req.headers["x-forwarded-host"] || "").toString().split(",")[0].trim();
  const host = (fwd || req.headers.host || "").toLowerCase();
  return ENV_POLICY || policyFor(host);
};
const EPOCH_ROTATE_MIN = 10;
const REDIS_TTL = 7 * 24 * 60 * 60;
const epoch = () => Math.floor(now() / (EPOCH_ROTATE_MIN * 60));
const pickKind = (mode, ep, step) => {
  const d = createHmac("sha256", SECRET).update(`${mode}:${ep}:${step}`).digest();
  const kinds = ["pow", "hdr"];
  return kinds[d[0] % kinds.length];
};

const makePow = (step, base, inc) => ({
  kind: "pow",
  step,
  nonce: b64u(randomBytes(16)),
  difficulty: base + inc * step
});
const checkPow = (ch, n) => sha(`${ch.nonce}:${n}`).startsWith("0".repeat(ch.difficulty));

const makeHdr = (step) => {
  const want = ["application/json", "text/plain"][step % 2];
  const etag = b64u(createHmac("sha256", "etag").update(String(step)).digest()).slice(0, 12);
  return { kind: "hdr", step, want, etag };
};
const checkHdr = (ch, req) => {
  const okA = (req.headers["accept"] || "").includes(ch.want);
  const okE = (req.headers["if-none-match"] || "") === ch.etag;
  return okA && okE;
};

const EPOCH_LEN = 10 * 60;
const epochKey = () => Math.floor(now() / EPOCH_LEN);
const scoreboard = new Map();

const idFor = (pubB64, ep) => {
  const body = Buffer.from(pubB64, "base64");
  const h = createHash("sha256").update("id:").update(String(ep)).update(":").update(body).digest("base64url");
  return h.slice(0, 10);
};
const bump = (ep, mode, id) => {
  if (!scoreboard.has(ep)) scoreboard.set(ep, new Map());
  const byMode = scoreboard.get(ep);
  if (!byMode.has(mode)) byMode.set(mode, new Map());
  const byId = byMode.get(mode);
  byId.set(id, (byId.get(id) || 0) + 1);
};

const spkiFromRawEd25519 = (raw32) =>
  Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw32]);
const pubKeyFromBase64 = (pubB64) => {
  const buf = Buffer.from(pubB64, "base64");
  const der = (buf.length === 32) ? spkiFromRawEd25519(buf) : buf;
  return createPublicKey({ key: der, format: "der", type: "spki" });
};
const verifyEd25519 = (dataBuf, pubB64, sigB64) => {
  try { return edVerify(null, dataBuf, pubKeyFromBase64(pubB64), Buffer.from(sigB64, "base64")); }
  catch { return false; }
};

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
};
const text = (res, code, s) => { res.writeHead(code, { "content-type": "text/plain; charset=utf-8" }); res.end(s); };
const readBody = (req, limit) => new Promise((resolve, reject) => {
  let s = "", size = 0;
  req.on("data", (c) => {
    size += c.length; if (size > limit) { reject(new Error("too_large")); req.destroy(); return; }
    s += c;
  });
  req.on("end", () => resolve(s));
  req.on("error", reject);
});
const safeParse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
const bearer = (req) => {
  const h = req.headers.authorization || ""; const m = /^Bearer (.+)$/.exec(h);
  return m ? m[1] : "";
};

http.createServer(async (req, res) => {
  const policy = policyFromReq(req);
  setSecureHeaders(res, policy.name);
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/") {
    return text(res, 200,
`MODE:    ${policy.name}

${`=`.repeat(40)}
start:   GET  /start
move:    POST /move 
          {"token":"...","n":"<pow-solution>"}
status:  GET  /status?token=...
prize:   GET  /prize?token=...
score:   POST /score/submit 
          {"token":"<done>","pub":"<b64>","sig":"<b64>"}
board:   GET  /scoreboard?epoch=<int>

(no cookies; carry tokens via Authorization: Bearer <token> or ?token=...)`);
  }

  if (req.method === "GET" && url.pathname === "/start") {
     if (!(await rateGate("start", req, res, policy, r))) return;
    const step = 0; const ep = epoch();
    const k = pickKind(policy.name, ep, step);
    const ch = (k === "pow") ? makePow(step, policy.diff0, policy.diffStep) : makeHdr(step);
    const tok = sign({ iss: "maze", mode: policy.name, exp: now() + policy.ttl, step, ch });
    return json(res, 200, { mode: policy.name, challenge: ch, token: tok });
  }

  if (req.method === "GET" && url.pathname === "/status") {
    const tok = bearer(req) || extractToken(req, url) || "";
    const p = verifyTok(tok); if (!p) return json(res, 400, { ok: false, err: "bad token" });
    const alive = now() <= p.exp;
    return json(res, 200, { ok: alive, step: p.step, mode: p.mode, exp: p.exp, challenge: p.ch });
  }

  if (req.method === "POST" && url.pathname === "/move") {
    if (!(await rateGate("move", req, res, policy, r))) return;
    try {
      const body = await readBody(req, policy.bodyLimit);
      const { token, n } = safeParse(body);
      const tok = token || bearer(req) || extractToken(req, url);
      const p = verifyTok(tok || ""); if (!p) return json(res, 400, { ok: false, err: "bad token" });
      if (p.mode !== policy.name) return json(res, 400, { ok: false, err: "wrong mode" });
      if (now() > p.exp) return json(res, 400, { ok: false, err: "expired" });

      const ok = (p.ch?.kind === "pow") ? checkPow(p.ch, String(n ?? "")) : (p.ch?.kind === "hdr") ? checkHdr(p.ch, req) : false;
      if (!ok) return json(res, 400, { ok: false, err: "bad proof" });

      const nextStep = (p.step | 0) + 1;
      if (nextStep >= policy.steps) {
        const jti = randomBytes(16).toString("base64url");
        const done = sign({ iss: "maze", mode: policy.name, exp: now() + policy.ttl, done: true, step: nextStep, jti });
        return json(res, 200, { ok: true, done: true, token: done });
      } else {
        const k2 = pickKind(policy.name, epoch(), nextStep);
        const ch2 = (k2 === "pow") ? makePow(nextStep, policy.diff0, policy.diffStep) : makeHdr(nextStep);
        const tok2 = sign({ iss: "maze", mode: policy.name, exp: now() + policy.ttl, step: nextStep, ch: ch2 });
        return json(res, 200, { ok: true, challenge: ch2, token: tok2 });
      }
    } catch (e) {
      const msg = e.message === "too_large" ? "too_large" : "bad_request";
      return json(res, 400, { ok: false, err: msg });
    }
  }

  if (req.method === "GET" && url.pathname === "/prize") {
    const tok = bearer(req) ||extractToken(req, url) || "";
    const p = verifyTok(tok); if (!p) return json(res, 400, { ok: false, err: "bad token" });
    if (p.mode !== policy.name) return json(res, 400, { ok: false, err: "wrong mode" });
    if (!p.done) return json(res, 403, { ok: false, err: "not done" });
    if (now() > p.exp) return json(res, 400, { ok: false, err: "expired" });

    const ep = epochKey();
    const epochEnd = (ep + 1) * EPOCH_LEN;
    const epochSecLeft = Math.max(0, epochEnd - now());
    const epochSecTotal = EPOCH_LEN;
    const epochSecElapsed = epochSecTotal - epochSecLeft;
    const tokenSecLeft = Math.max(0, p.exp - now());

    const vars = {
      MODE: policy.name,
      STEP: p.step,
      EPOCH: ep,
      EPOCH_SEC_LEFT: epochSecLeft,
      EPOCH_SEC_ELAPSED: epochSecElapsed,
      EPOCH_SEC_TOTAL: epochSecTotal,
      TOKEN_SEC_LEFT: tokenSecLeft,
    };

    const prizeText = await loadPrize(policy.name, vars);
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");

    const a = `${getPrizeEmoji()}*`.repeat(20);
    const banner = `${a}\n\n************ You finished ${policy.name}! ************\n`;
    const block = prizeText ? `\n${a}\n\n${prizeText}\n\n${a}\n` : "";
    return res.end(banner + block);
  }

  if (req.method === "POST" && url.pathname === "/score/submit") {
    if (!(await rateGate("submit", req, res, policy, r))) return;
    try {
      const bodyStr = await readBody(req, 4096);
      const { token, pub, sig } = safeParse(bodyStr);
      const payload = verifyTok(token || "");
      if (!payload || !payload.done) return json(res, 400, { ok: false, err: "bad token" });
      if (now() > payload.exp) return json(res, 400, { ok: false, err: "expired" });
      if (!payload.jti) return json(res, 400, { ok: false, err: "no jti" });
      const jkey = `maze:jti:${payload.jti}`;
      const ok = await r.set(jkey, "1", { NX: true, EX: REDIS_TTL });
      if (ok !== "OK") return json(res, 409, { ok:false, err:"already counted" });
      const ep = epochKey();
      const mode = policy.name;
      const msg = Buffer.from(`score:${ep}:${mode}:${payload.jti}`);
      if (!pub || !sig || !verifyEd25519(msg, pub, sig)) {
        return json(res, 400, { ok: false, err: "bad signature" });
      }

      const id = idFor(pub, ep);
      bump(ep, mode, id);

      try {
        const zkey = boardKey(ep, mode);
        await r.zIncrBy(zkey, 1, id);
        await r.expire(zkey, REDIS_TTL);
      } catch { }

      const count = scoreboard.get(ep)?.get(mode)?.get(id) || 0;
      return json(res, 200, { ok: true, epoch: ep, mode, id, count });
    } catch {
      return json(res, 400, { ok: false, err: "bad request" });
    }
  }

  if (req.method === "GET" && url.pathname === "/scoreboard") {
    const ep = Number(url.searchParams.get("epoch") ?? epochKey());
    const mode = policy.name;
    const K = 1;
    const LIMIT = 50;
    const rows = await getBoardTop(ep, mode, LIMIT, K);
    return json(res, 200, { epoch: ep, mode, k: K, rows });
  }

  return text(res, 404, "not found");
}).listen(PORT, () => {
  console.log(`Running on port ${PORT}`);
});
