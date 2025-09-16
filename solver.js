import crypto from "node:crypto";

const host = process.argv[2] || "http://localhost:3000";
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const b64uToJSON = (p) => JSON.parse(Buffer.from(p, "base64url").toString("utf8"));

async function getJSON(path, token) {
  const r = await fetch(host + path, {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      accept: "application/json",
      "accept-encoding": "identity"
    }
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`GET ${path} => ${r.status} ${r.statusText}: ${t}`);
  }
  return r.json();
}

async function postJSON(path, body, headers = {}) {
  const r = await fetch(host + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "accept-encoding": "identity",
      ...headers
    },
    body: JSON.stringify(body || {})
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`POST ${path} => ${r.status} ${r.statusText}: ${t}`);
  }
  return r.json();
}

function solvePow(nonce, D) {
  const target = "0".repeat(D);
  for (let n = 0; ; n++) {
    if (sha(`${nonce}:${n}`).startsWith(target)) return String(n);
  }
}

(async () => {
  let { token, challenge } = await getJSON("/start");
  for (;;) {
    if (!challenge) throw new Error("no challenge from server");
    if (challenge.kind === "pow") {
      const n = solvePow(challenge.nonce, challenge.difficulty);
      const res = await postJSON("/move", { n }, { authorization: `Bearer ${token}` });
      if (res.done) { token = res.token; break; }
      token = res.token; challenge = res.challenge;
    } else if (challenge.kind === "hdr") {
      const res = await fetch(host + "/move", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: challenge.want,
          "if-none-match": challenge.etag,
          authorization: `Bearer ${token}`,
          "accept-encoding": "identity"
        },
        body: "{}"
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`POST /move (hdr) => ${res.status} ${res.statusText}: ${t}`);
      }
      const j = await res.json();
      if (j.done) { token = j.token; break; }
      token = j.token; challenge = j.challenge;
    } else {
      throw new Error(`unknown challenge kind: ${challenge.kind}`);
    }
  }

  const prize = await fetch(host + `/prize?token=${encodeURIComponent(token)}`, {
    headers: { "accept-encoding": "identity" }
  }).then(r => r.text());
  console.log(prize.trim());

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  const raw32 = new Uint8Array(der).slice(der.length - 32);
  const pubB64 = Buffer.from(raw32).toString("base64");
  const payload = b64uToJSON(token.split(".")[0]);
  if (!payload.jti) throw new Error("done token missing jti");

  /* Uncomment to run 

  const boardInfo = await getJSON("/scoreboard");
  const ep = boardInfo.epoch;
  const mode = payload.mode;
  const msg = Buffer.from(`score:${ep}:${mode}:${payload.jti}`);
  const sigB64 = crypto.sign(null, msg, privateKey).toString("base64");
  const res = await postJSON("/score/submit", { token, pub: pubB64, sig: sigB64 });
  console.log(`\nscore accepted: id=${res.id} count=${res.count} epoch=${res.epoch} mode=${res.mode}`);
  
  */
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
