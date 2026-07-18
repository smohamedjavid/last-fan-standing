/**
 * Runs the verify page's <script> logic (extracted verbatim from
 * web/verify.html) in Node's WebCrypto — the same API surface a browser
 * exposes — against a real certificate. Catches page-logic drift without a
 * browser in the loop.
 *
 *   npx tsx scripts/verify-page-check.ts [path-to-cert.json]
 */
import fs from "node:fs";

const html = fs.readFileSync(new URL("../../web/verify.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
if (!script) throw new Error("no <script> in verify.html");

// Lift the pure functions out of the page (everything before "---- the checks").
// Deliberate eval-of-our-own-source: this dev-only script executes the repo's
// checked-in page code so the test can't drift from what ships. Never feed it
// anything but web/verify.html.
const pure = script.split("// ---- the checks")[0];
const factory = new Function(
  "crypto",
  "fetch",
  pure +
    "\nreturn { b58decode, hexToBytes, sha256hex, ed25519verify, RPC };"
);
const page = factory(globalThis.crypto, globalThis.fetch);

const certPath =
  process.argv[2] ??
  new URL("../../evidence/smoke-2026-07-18/survivor-cert-nina-demo.json", import.meta.url).pathname;
const cert = JSON.parse(fs.readFileSync(certPath, "utf8"));
console.log(`cert: ${cert.survivor.name} · ${cert.rounds.length} rounds · anchor ${cert.anchorWallet}`);

let ok = true;
for (const r of cert.rounds) {
  const recomputed = await page.sha256hex(
    [cert.lobbyId, String(r.n), cert.survivor.playerId, r.pick, r.salt].join("|")
  );
  const hashOk = recomputed === r.commitHash;
  const sigOk = await page.ed25519verify(cert.survivor.pubkey, r.sig, r.commitHash);
  console.log(`round ${r.n}: hash ${hashOk ? "✓" : "✗"} sig ${sigOk === true ? "✓" : sigOk === null ? "(no ed25519)" : "✗"}`);
  if (!hashOk || sigOk === false) ok = false;
}

const material = [
  cert.p, cert.lobbyId, String(cert.fixtureId), cert.survivor.playerId, cert.survivor.pubkey,
  ...cert.rounds.map((r: { n: number; pick: string; salt: string; commitHash: string; sig: string; correct: string }) =>
    [r.n, r.pick, r.salt, r.commitHash, r.sig, r.correct].join("|")
  ),
].join("\n");
const certHash = await page.sha256hex(material);
console.log(`cert hash: ${certHash}`);

const res = await fetch(page.RPC, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress",
    params: [cert.anchorWallet, { limit: 1000 }],
  }),
});
const body = await res.json();
const hit = (body.result ?? []).find((e: { memo?: string }) => e.memo?.includes(certHash));
console.log(hit ? `on-chain: ✓ found in tx ${hit.signature.slice(0, 20)}…` : "on-chain: ✗ NOT FOUND");
if (!hit) ok = false;

// a tampered cert must fail
const tampered = structuredClone(cert);
tampered.rounds[0].pick = tampered.rounds[0].pick === "home" ? "away" : "home";
const tamperedHashOk =
  (await page.sha256hex(
    [tampered.lobbyId, String(tampered.rounds[0].n), tampered.survivor.playerId, tampered.rounds[0].pick, tampered.rounds[0].salt].join("|")
  )) === tampered.rounds[0].commitHash;
console.log(`tamper check: ${tamperedHashOk ? "✗ tampered pick slipped through" : "✓ tampered pick rejected"}`);
if (tamperedHashOk) ok = false;

console.log(ok ? "VERIFY-PAGE LOGIC: PASS" : "VERIFY-PAGE LOGIC: FAIL");
process.exit(ok ? 0 : 1);
