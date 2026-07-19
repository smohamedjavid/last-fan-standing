# LAST FAN STANDING — technical deep-dive

This document is for judges and anyone auditing the README's claim: that a
group-chat survivor pool can be made impossible to welch on. Every section
cites real files. Where something is custodial or approximated, it says so.

Live: [lastfanstanding.vercel.app](https://lastfanstanding.vercel.app) ·
anchor wallet [`AHs1Q6z9VRBnS3gq13tHTnXGk85Qfyk1MjgBE5rKQ8yi`](https://explorer.solana.com/address/AHs1Q6z9VRBnS3gq13tHTnXGk85Qfyk1MjgBE5rKQ8yi?cluster=devnet) ·
43 tests (`npm test`) · real devnet evidence in `evidence/smoke-2026-07-18/`.

## Design rule: pure core, dumb shell

The code that decides who lives, who dies, and what counts as proof is pure
functions with no I/O, no clock, and no chain access:

- `service/src/royale.ts` — elimination rules, jinx rules, crowning
- `service/src/questions.ts` — question generation + resolution
- `service/src/keys.ts` / `merkle.ts` / `cert.ts` — hashing and signatures

`service/src/engine.ts` orchestrates (DB, Telegram, Memo anchoring). The two
drivers — `ingest.ts` (live TxLINE) and `demo.ts` (scripted matchday) — only
decide *when* things happen, never *what counts*. A demo elimination and a
live elimination run the exact same `settleRound` path, which is why the demo
is honest: the football is a rerun, the cryptography is not.

## The royale state machine

Lobby states (`service/src/schema.ts`, driven by `engine.ts` + `ingest.ts`):

```
open ──(kickoff, ≥2 players)──▶ locked ──(round 1 opens)──▶ live ──▶ finished
  └──(kickoff, <2 players)──▶ finished (aborted)
```

Rounds within a live lobby: `open → closed → resolved | voided`. A separate
forfeit track runs after the match: `voting → chosen → proofed`.

The rules, all in `royale.ts` and unit-tested in `test/royale.test.ts`:

- Wrong answer → eliminated. Silent → eliminated, except round 1
  (`GRACE_ROUND_1` — people are still finding their thumbs).
- If a round would eliminate *everyone* remaining, it's voided and nobody
  dies. A survivor pool with no survivors is just a graveyard.
- Down to one player → decided. Multiple still alive at full time →
  co-survivors, each certified.
- KIRICOCHO: one jinx per living player per match, cast before a round
  resolves; `canJinx` rejects self-jinx, dead jinxers, dead targets, and
  double-dipping. Landing a jinx credits the wall chart and nothing else —
  it never affects scoring, which is the point.

## What makes it welch-proof

### 1. Signed pick commitments (`service/src/keys.ts`)

Joining a pool mints the player a real Solana keypair. Every answer becomes:

```
commitHash = sha256(lobbyId | roundN | playerId | option | salt)
sig        = ed25519_sign(commitHash, player_secret_key)
```

The salt is 8 random bytes per answer. Players can change their answer while
the window is open — the record is upserted and re-signed
(`engine.answer()`); the last signed commitment before the window closes is
the one that counts.

### 2. Per-round Merkle root, anchored before the announcement

When a round resolves (`engine.settleRound`), the signed picks are sorted by
player id, hashed into leaves — `leafHash = sha256(commitHash | sig)`, so the
tree binds both the pick and the signature — and rolled into a binary Merkle
root (`service/src/merkle.ts`, odd nodes promoted, not duplicated). That root
goes to Solana devnet via the Memo program **before the verdict is posted to
the group**:

```json
{"p":"lfs/round/v1","l":"<lobbyId>","n":2,"r":"<merkleRoot>","c":"home","k":5}
```

Ordering is the whole trick. By the time anyone knows who died, the round's
complete set of signed picks is already committed on-chain. "I actually said
X before the goal" now requires rewriting devnet history.

### 3. The survivor certificate (`service/src/cert.ts`)

The winner's certificate is the full path of their correct picks — for each
resolved round: the question, the pick, the salt, the commit hash, the
signature, the correct answer, the round's Merkle root and its Memo
signature. The certificate hash is computed over a **fixed field order**
(protocol tag, lobby, fixture, player id, pubkey, then per-round
`n|pick|salt|commitHash|sig|correct`), deliberately independent of JSON
serialization, and anchored in its own Memo:

```json
{"p":"lfs/cert/v1","l":"<lobbyId>","f":18257739,"k":"<survivor pubkey>","h":"<certHash>","n":4}
```

A certificate is anchored exactly once — re-sends (`/receipt`) reuse the
stored cert and anchor rather than re-anchoring.

The forfeit contract works the same way: the group's vote is tallied
(deterministic tiebreak by template order), the result is notarized as
`lfs/forfeit/v1` with the loser's pubkey, and the debt settles only with a
`/proof` photo. No money exists anywhere in this system; the ledger is
social, the notarization is real.

### 4. The verify page recomputes everything (`web/verify.html`)

One static HTML file, no build step, no dependencies — the base58 decoder is
inlined. Paste the certificate JSON and the judge's own browser:

1. Recomputes every `commitHash` with WebCrypto SHA-256 from the revealed
   pick, salt, and ids.
2. Verifies every ed25519 signature against the survivor's pubkey with
   WebCrypto Ed25519. Browsers without Ed25519 support get an explicit
   "inconclusive" state — never a fake pass.
3. Rebuilds the certificate hash from the same fixed field order.
4. Calls `getSignaturesForAddress` on the anchor wallet (one public devnet
   RPC call, no wallet, no account) and searches the Memo trail for the
   rebuilt hash.

Green means: this exact path of picks existed, signed by this key, before the
football happened. Our server is not in the loop — the page even tells you to
view source.

## TxLINE ingest (`service/src/ingest.ts`)

Live rounds are fired by the real feed, belt and braces:

- **SSE** (`/api/scores/stream`) for immediacy, plus a **15-second snapshot
  sweep** (`/api/scores/snapshot/{fixtureId}`, highest `Seq` wins) for
  correctness across missed events and restarts. Fixture metadata refreshes
  every 10 minutes.
- **Goals** are detected as increments of
  `Score.Participant{1,2}.Total.Goals` between records.
- **Full time** is the detail that cost us a live match to learn, verified
  against real fixtures on 2026-07-04: `GameState` never changes at the end
  of a match. The real signals are `Action: "game_finalised"` and
  `StatusId: 5` — match phase lives in `StatusId` — with a late
  `disconnected` (100+ minutes after kickoff) as the backstop.
- **Minutes** are wall-clock derived from kickoff and logged as such — an
  honest approximation, used for tombstone flavor and question deadlines,
  never for anything a signature depends on.
- The devnet StablePrice feed doesn't carry cards, so live rounds stick to
  goal and time triggers (kickoff question, every goal, half-time window,
  75' late-drama window, full time; shootouts go kick-by-kick). Every
  question stays recomputable from the feed — the card question type exists
  in `questions.ts` and activates when the data does.

Questions are deterministic (`questionForTrigger`: same context, same
question) and resolve only against observed `MatchEvent`s
(`resolveQuestion`); if the evidence can't settle a question yet, it stays
pending rather than guessing. This is what makes every elimination
recomputable by a third party: committed picks + feed facts + published rules.

## What's custodial, what's client-side

| Piece | Where it lives | Why |
|---|---|---|
| Player keypairs | server-side (`players` table) | players are non-crypto humans in a group chat; keys are zero-value devnet identities. **Custodial today, stated plainly.** Roadmap: client-side keys in a Telegram Mini App so the server can't sign for you even in theory |
| Pick signing | server, with the player's own key, at the moment they tap | the signature and its timing are real; only key storage is delegated |
| Round + cert + forfeit anchoring | one service wallet (`AHs1Q6z9…Q8yi`) via the Memo program | anchoring is a notary function; the *content* is bound to per-player keys |
| Verification | 100% client-side (`web/verify.html`) | the trust story has to terminate somewhere that isn't us |
| Money | nonexistent | stakes are glory and forfeits — that's why real group chats will run it, and why there's no custody or regulatory surface |

Storage is libsql via drizzle with additive migrations
(`service/src/db.ts`, `schema.ts`, exercised in `test/db.test.ts`).
`service/src/api.ts` exposes a small read-only API for the verify page;
secrets never leave the players table.

## The demo driver (`service/src/demo.ts`)

`/demo` replays the 2022 final (Argentina–France, compressed to ~3 minutes)
with four scripted fans alongside the real user. Real keypairs are minted,
picks are really signed, Memos really land on devnet — the script only
supplies the match events. It runs in any chat with the bot, including a DM,
with zero live-data dependency, which makes it the judge path.

`service/scripts/smoke.ts` runs the same matchday headless against real
devnet (Telegram stubbed), then archives the Memo transactions and the
survivor certificate as JSON into `evidence/` — because devnet keeps only
about four days of transaction history, all published links are account
links and the raw transactions live in the repo.
`service/scripts/verify-page-check.ts` runs the verify page's own logic in
Node's WebCrypto against a real certificate, so the browser verifier is
itself under test.

## Known gaps and roadmap

- **Inclusion proofs.** The round Memo carries the Merkle root; the
  certificate carries the winner's leaves. A verifier currently checks the
  survivor's own hashes and the anchored cert hash — the next step is
  shipping each player's sibling path so any single pick can be proven
  against the round root without the full answer set.
- **Client-side keys** in a Telegram Mini App (kills the custodial caveat).
- **Richer rounds** (cards, xG props) as the feed exposes them; season-long
  pools across a tournament, which is where survivor culture actually lives.
- **Bot identity**: the bot token survives a BotFather rename; the handle is
  being finalized for submission.
