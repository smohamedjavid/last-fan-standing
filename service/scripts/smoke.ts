/**
 * Headless smoke: runs the full scripted demo matchday against REAL devnet —
 * real keypairs, real signatures, real Memo transactions — with Telegram
 * stubbed to stdout. Then it re-verifies the survivor certificate exactly the
 * way the browser verify page does (recompute hashes + search the anchor
 * wallet's Memo trail over public RPC) and archives the evidence JSONs.
 *
 *   npx tsx scripts/smoke.ts
 */

process.env.DB_URL ??= "file:smoke.db";
process.env.DEMO_WINDOW_MS ??= "5000";
process.env.DEMO_JOIN_MS ??= "2000";
process.env.DEMO_VOTE_MS ??= "3000";

import fs from "node:fs";
import { createHash } from "node:crypto";

const { migrate, db } = await import("../src/db.js");
const { Engine } = await import("../src/engine.js");
const { runDemo } = await import("../src/demo.js");
const { keypairMemoSender, accountLink } = await import("../src/memo.js");
const { certHash } = await import("../src/cert.js");
const { verifySig } = await import("../src/keys.js");
const { certs, rounds, lobbies } = await import("../src/schema.js");
const { eq } = await import("drizzle-orm");
const { Connection, PublicKey } = await import("@solana/web3.js");

const say = (...a: unknown[]) => console.log("[smoke]", ...a);

// Telegram stub: every send becomes a log line so the whole flow is visible.
const stubBot = {
  api: {
    sendMessage: async (_c: number, text: string) => {
      console.log("  [tg] " + text.split("\n")[0]);
      return {};
    },
    sendPhoto: async () => (console.log("  [tg] (photo: wall chart / tombstone)"), {}),
    sendDocument: async () => (console.log("  [tg] (document: survivor certificate)"), {}),
  },
} as never;

if (fs.existsSync("smoke.db")) fs.rmSync("smoke.db");
await migrate();

const memo = keypairMemoSender();
say("anchor wallet:", memo.wallet);
say("account link:", accountLink(memo.wallet));

const conn = new Connection(process.env.RPC ?? "https://solana-devnet.api.onfinality.io/public", "confirmed");
const balance = await conn.getBalance(new PublicKey(memo.wallet));
say("balance:", balance / 1e9, "SOL");

const engine = new Engine(stubBot, memo);
const t0 = Date.now();
await runDemo(engine, -424242, 424242, "Javid");
say(`demo completed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// ---- re-verify like the browser does ---------------------------------------
const certRows = await db.query.certs.findMany({});
if (certRows.length === 0) throw new Error("no certificate issued — smoke FAILED");

for (const row of certRows) {
  const cert = JSON.parse(row.certJson);
  say(`certificate: ${cert.survivor.name}, ${cert.rounds.length} rounds, hash ${row.certHash.slice(0, 16)}…`);

  // 1) recompute every pick hash
  for (const r of cert.rounds) {
    const recomputed = createHash("sha256")
      .update([cert.lobbyId, String(r.n), cert.survivor.playerId, r.pick, r.salt].join("|"))
      .digest("hex");
    if (recomputed !== r.commitHash) throw new Error(`round ${r.n} hash mismatch`);
    if (!verifySig(r.commitHash, r.sig, cert.survivor.pubkey)) throw new Error(`round ${r.n} sig invalid`);
  }
  say("  ✓ all pick hashes recompute, all signatures verify");

  // 2) recompute the certificate hash
  if (certHash(cert) !== row.certHash) throw new Error("cert hash mismatch");
  say("  ✓ certificate hash recomputes");

  // 3) find it in the anchor wallet's Memo trail
  const sigs = await conn.getSignaturesForAddress(new PublicKey(memo.wallet), { limit: 200 });
  const hit = sigs.find((s) => s.memo?.includes(row.certHash));
  if (!hit) throw new Error("cert hash NOT found in memo trail");
  say(`  ✓ cert hash found on-chain in tx ${hit.signature.slice(0, 20)}… (memo trail)`);
}

// ---- archive evidence -------------------------------------------------------
const stamp = new Date().toISOString().slice(0, 10);
const dir = new URL(`../../evidence/smoke-${stamp}/`, import.meta.url).pathname;
fs.mkdirSync(dir, { recursive: true });

const lobby = (await db.query.lobbies.findMany({}))[0];
const roundRows = await db.query.rounds.findMany({ where: eq(rounds.lobbyId, lobby.id) });
const memoSigs: Array<{ kind: string; sig: string }> = [];
for (const r of roundRows) if (r.memoSig) memoSigs.push({ kind: `round-${r.n}`, sig: r.memoSig });
for (const c of certRows) if (c.memoSig) memoSigs.push({ kind: "cert", sig: c.memoSig });
if (lobby.forfeitMemoSig) memoSigs.push({ kind: "forfeit", sig: lobby.forfeitMemoSig });

for (const { kind, sig } of memoSigs) {
  const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
  fs.writeFileSync(`${dir}${kind}.tx.json`, JSON.stringify({ signature: sig, tx }, null, 2));
}
for (const row of certRows) {
  const cert = JSON.parse(row.certJson);
  const who = cert.survivor.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  fs.writeFileSync(`${dir}survivor-cert-${who}.json`, JSON.stringify(cert, null, 2));
}
fs.writeFileSync(
  `${dir}anchor.json`,
  JSON.stringify(
    {
      wallet: memo.wallet,
      accountLink: accountLink(memo.wallet),
      note: "devnet keeps ~4 days of tx history — the account link is the durable reference; these JSONs are the archived transactions",
      memos: memoSigs,
    },
    null,
    2
  )
);
say(`evidence archived → evidence/smoke-${stamp}/ (${memoSigs.length} memo txs)`);
say("SMOKE PASSED");
process.exit(0);
