# LAST FAN STANDING

The survivor pool your group chat already runs — compressed into the ninety
minutes of one match, and impossible to welch.

Telegram-native. No wallet, no app, no money ever. Just sudden-death picks on
live match events, tombstones for the fallen, one certificate for the survivor,
and one notarized forfeit for the first fan out.

Live at [lastfanstanding.vercel.app](https://lastfanstanding.vercel.app) —
product page plus the no-wallet certificate verifier. Deep-dive for the
curious: [TECHNICAL.md](TECHNICAL.md).

## The 90-minute loop

1. **`/royale`** in your group opens a pool on the next fixture. One tap to
   join — joining mints you a Solana keypair, and that key signs every pick you
   make from then on. The lobby locks at kickoff.
2. **Rounds fire on real events** from the TxLINE live data feed: kickoff, every
   goal, half-time, the 75th minute, full time — penalty shootouts go
   kick-by-kick. Each round is one sudden-death question answerable only from
   the match stats ("Next goal before 60' — Spain, Argentina, or nobody?"),
   answered with inline buttons inside a sixty-second window.
3. **Wrong or silent = eliminated.** (Round 1 forgives silence; after that a
   closed mouth is a wrong answer.) The dead get a hand-inked tombstone card —
   name, fatal pick, minute — and a eulogy from the graveside announcer. Ghosts
   spectate and keep exactly one `/haunt`.
4. **KIRICOCHO.** Every living player carries one `/jinx <name>` per match. If
   the cursed rival dies that round, the wall chart credits the kill. Pure
   drama — it never affects scoring, which is exactly why it works.
5. **The wall chart** — a server-rendered, hand-drawn bracket of who's alive,
   who's buried, and who jinxed whom — reposts every round. The final version
   is the keepsake.
6. **Endgame.** The last fan standing gets a survivor certificate: their full
   path of correct signed picks, hashed and anchored on-chain. The first fan
   out gets the **forfeit contract**: the group votes one of three punishments
   (display-name rule / profile-pic rule / biscuits IOU), the result is
   notarized in the same Memo trail, and the debt settles only with
   photographic `/proof`.

## Why it can't welch

Every answer becomes `sha256(pool | round | player | pick | salt)`, signed with
the player's own ed25519 key at the moment they tap. When a round resolves, the
signed picks are merkle-rooted and written to Solana devnet via the Memo
program — **before the next outcome exists**. The survivor's certificate hash
lands in the same trail.

So the three ways group-chat pools die are closed:

- **"I never picked that"** — you signed it; the signature verifies against
  your key in any browser.
- **"I actually said X before the goal"** — the round root was on-chain before
  the goal was announced. Backdating requires rewriting devnet.
- **"The organizer fixed it"** — every elimination is recomputable from the
  TxLINE stats and the committed picks. We publish the maths, not a verdict.

The [verify page](web/verify.html) recomputes all of it — pick hashes, ed25519
signatures, certificate hash, and the on-chain Memo lookup — with WebCrypto and
one public RPC call. No wallet, no account, no trusting us.

## Trust model, honestly

- **No money ever moves.** Stakes are glory and forfeits. That's a feature:
  it's why your actual group chat will play it, and why there's no regulatory
  or custody surface.
- **Keys are custodial today.** Players are non-crypto humans in a group chat;
  their keypairs live server-side and sign on their behalf. The signatures and
  anchors are real. Roadmap: client-side keys in a Telegram Mini App so the
  server can't sign for you even in theory.
- **Round questions come from the live feed** and resolve only against feed
  facts. Minutes are wall-clock-derived from kickoff and logged.
- **Devnet keeps ~4 days of transaction history**, so all published links are
  account links (the anchor wallet's explorer page) and every smoke-run
  transaction is archived as JSON under `evidence/`.

## Judge path (3 minutes, zero setup)

1. Open the bot, type **`/demo`** in any chat with it (a DM works). You get the
   full compressed matchday — a clearly-labeled rerun of the 2022 final with
   four scripted fans alongside you: join → signed picks → real devnet Memo
   anchors → eliminations → funerals → a kiricocho kill → survivor certificate
   → forfeit vote. The football is scripted; the cryptography is not.
2. Take the `survivor-cert-….json` the bot posts and paste it into
   [the verify page](https://lastfanstanding.vercel.app/verify.html)
   (`web/verify.html` — hosted or opened locally, same file). Watch your own
   browser recompute the hashes and find the anchor on devnet.
3. Anchor account: the wallet printed by the service at boot —
   [explorer link in evidence/](evidence/).

## Architecture

```
last-fan-standing/
├── service/            the whole product: bot + engine + chain + images
│   ├── src/
│   │   ├── royale.ts        pure sudden-death rules (eliminations, jinx, crowns)
│   │   ├── questions.ts     question generation + resolution vs match events
│   │   ├── keys.ts          per-player keypair mint, pick hashing, ed25519
│   │   ├── merkle.ts        round merkle roots over signed picks
│   │   ├── cert.ts          survivor certificate build + stable hashing
│   │   ├── memo.ts          Solana Memo anchoring (rounds, certs, forfeits)
│   │   ├── engine.ts        orchestration: rounds, funerals, forfeits, charts
│   │   ├── wallchart.ts     hand-inked SVG → PNG (tombstones, tallies, jinx marks)
│   │   ├── pundit.ts        the graveside announcer (templates; optional LLM polish)
│   │   ├── bot.ts           Telegram surface (grammY, inline keyboards)
│   │   ├── ingest.ts        TxLINE SSE + snapshot sweep → round triggers
│   │   ├── demo.ts          the scripted 3-minute matchday
│   │   └── api.ts           read API for the verify page
│   ├── scripts/smoke.ts     E2E: demo vs real devnet + evidence archiving
│   └── test/                43 tests, fork-isolated vitest
├── web/                static product page + no-wallet certificate verifier
└── evidence/           archived Memo transactions from real runs
```

Pure logic (rules, questions, hashing, merkle) is isolated from I/O and fully
unit-tested. The engine orchestrates; the drivers (live ingest, scripted demo)
only decide *when* things happen, never *what counts* — that's the same code
path in demo and live.

## Running it

```bash
npm install

# tests (elimination logic, jinx rules, sig roundtrip, cert hash, migrations, full E2E round)
npm test

# the service (Telegram bot + live ingest + read API)
cd service
TELEGRAM_BOT_TOKEN=… TXLINE_JWT=… TXLINE_API_TOKEN=… npx tsx src/main.ts

# headless smoke against real devnet (stubs Telegram, sends real Memos, archives evidence)
npx tsx scripts/smoke.ts
```

Optional env: `RPC` (devnet RPC URL), `MEMO_KEYPAIR` (anchor wallet path),
`ANTHROPIC_API_KEY` (funeral-line polish; deterministic templates otherwise),
`ROUND_WINDOW_MS` / `DEMO_WINDOW_MS` (answer windows).

The web pages are static files — open `web/index.html`, or serve the directory
with anything.

## Built with

TxLINE live football data (SSE + snapshots) · Solana devnet Memo program ·
grammY · libsql · resvg · tweetnacl · three hand-lettering fonts and one red pen.
