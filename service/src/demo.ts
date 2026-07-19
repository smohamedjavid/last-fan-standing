import { eq } from "drizzle-orm";
import { db } from "./db.js";
import { lobbies } from "./schema.js";
import type { Engine } from "./engine.js";
import type { MatchEvent, QuestionCtx, Trigger } from "./questions.js";

/**
 * The judge path: a fully scripted three-minute replay matchday, runnable in
 * any fresh group (or a DM) with zero live data. Clearly labeled DEMO, but
 * nothing is faked where it matters — real keypairs, really signed picks,
 * real Memo transactions on devnet. Only the football is a rerun.
 *
 * The rerun in question: the greatest final ever played, compressed.
 */

const WINDOW = Number(process.env.DEMO_WINDOW_MS ?? 25_000);
const JOIN_WINDOW = Number(process.env.DEMO_JOIN_MS ?? 12_000);
const VOTE_WINDOW = Number(process.env.DEMO_VOTE_MS ?? 20_000);
const BEAT = Math.max(1500, Math.round(WINDOW / 8));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Bot {
  tgId: number;
  name: string;
}
const BOTS: Bot[] = [
  { tgId: -101, name: "Tariq (demo)" },
  { tgId: -102, name: "Nina (demo)" },
  { tgId: -103, name: "Ravi (demo)" },
  { tgId: -104, name: "Meg (demo)" },
];
const [TARIQ, NINA, RAVI, MEG] = BOTS;

interface ScriptedRound {
  trigger: Trigger;
  ctx: QuestionCtx;
  /** flavour lines posted just before resolution (the "match happening") */
  beats: string[];
  /** events observed since the round opened — what resolves the question */
  events: MatchEvent[];
  minute: number;
  answers: Array<{ tgId: number; option: string }>;
  /** cast before this round resolves */
  jinx?: { tgId: number; target: string };
}

const HOME = "Argentina";
const AWAY = "France";

const SCRIPT: ScriptedRound[] = [
  {
    trigger: "kickoff",
    ctx: { home: HOME, away: AWAY, minute: 0, homeGoals: 0, awayGoals: 0 },
    beats: [`23' — penalty. Messi sends the keeper the wrong way. ${HOME} 1–0 ${AWAY}.`],
    events: [{ type: "goal", side: "home", minute: 23, note: "Messi (pen)" }],
    minute: 23,
    answers: [
      { tgId: TARIQ.tgId, option: "away" }, // fatal
      { tgId: NINA.tgId, option: "home" },
      { tgId: RAVI.tgId, option: "home" },
      // Meg stays silent — round-1 grace saves her, this once
    ],
  },
  {
    trigger: "goal",
    ctx: { home: HOME, away: AWAY, minute: 23, homeGoals: 1, awayGoals: 0 },
    beats: [`36' — Di María finishes the move of the tournament. ${HOME} 2–0 ${AWAY}.`],
    events: [{ type: "goal", side: "home", minute: 36, note: "Di María" }],
    minute: 36,
    answers: [
      { tgId: NINA.tgId, option: "home" },
      { tgId: RAVI.tgId, option: "away" }, // fatal
      { tgId: MEG.tgId, option: "away" }, // fatal — and cursed
    ],
    jinx: { tgId: NINA.tgId, target: "Meg" },
  },
  {
    trigger: "halftime",
    ctx: { home: HOME, away: AWAY, minute: 45, homeGoals: 2, awayGoals: 0 },
    beats: [`62' — France finally wake up; a booking for dissent is all the second half has produced.`],
    events: [{ type: "card", side: "away", minute: 62 }],
    minute: 62,
    answers: [{ tgId: NINA.tgId, option: "nobody" }],
  },
  {
    trigger: "late",
    ctx: { home: HOME, away: AWAY, minute: 75, homeGoals: 2, awayGoals: 0 },
    beats: [
      `80' — Mbappé from the spot. ${HOME} 2–1 ${AWAY}.`,
      `81' — Mbappé again. NINETY-SEVEN SECONDS. 2–2. This group chat is now a medical event.`,
    ],
    events: [{ type: "goal", side: "away", minute: 80, note: "Mbappé (pen)" }],
    minute: 81,
    answers: [{ tgId: NINA.tgId, option: "yes" }],
  },
  {
    trigger: "shootout",
    ctx: { home: HOME, away: AWAY, minute: 120, homeGoals: 3, awayGoals: 3 },
    beats: [
      `Extra time settles nothing. 3–3. Penalties. Sudden death for them, sudden death for you.`,
      `Kick 1 — Mbappé. Buried.`,
    ],
    events: [{ type: "shootout_kick", scored: true, minute: 121, note: "Mbappé" }],
    minute: 121,
    answers: [{ tgId: NINA.tgId, option: "scored" }],
  },
];

const SCRIPTED_VOTES = [
  { tgId: TARIQ.tgId, choice: "biscuits" }, // the condemned votes for the soft option
  { tgId: RAVI.tgId, choice: "name" },
  { tgId: MEG.tgId, choice: "name" },
];

export async function runDemo(
  engine: Engine,
  chatId: number,
  userTgId: number,
  userName: string
): Promise<void> {
  const lobby = await engine.openLobby({
    chatId,
    fixtureId: 99022018,
    home: HOME,
    away: AWAY,
    kickoff: Date.now() + JOIN_WINDOW,
    demo: true,
  });

  await engine.join(lobby.id, userTgId, userName);
  for (const b of BOTS) await engine.join(lobby.id, b.tgId, b.name, true);
  await engine.say(
    lobby,
    null,
    "demo",
    `DEMO MODE — a compressed rerun of the 2022 final. The football is scripted; ` +
      `the keys, signatures and devnet Memo anchors are real.\n\n` +
      `${userName}, you're dealt in, alongside four scripted fans: ${BOTS.map((b) => b.name.split(" ")[0]).join(", ")}. ` +
      `Anyone else in this chat has ${Math.round(JOIN_WINDOW / 1000)} seconds to tap in. ` +
      `Answer fast, trust nobody, and if things get desperate — /jinx someone.`
  );
  await sleep(JOIN_WINDOW);
  await engine.lock(lobby.id);
  await sleep(2000);

  let decided = false;
  for (const r of SCRIPT) {
    if (decided) break;
    const { round } = await engine.openRound(lobby.id, r.trigger, r.ctx, WINDOW);
    const currentRound = round.n;

    // scripted fans answer at staggered human-ish moments inside the window
    r.answers.forEach((a, i) => {
      setTimeout(
        () => {
          void engine.answer(lobby.id, currentRound, a.tgId, a.option).catch((e) => {
            console.error("[demo] scripted answer failed:", (e as Error).message);
          });
        },
        BEAT * (i + 1.5)
      );
    });

    if (r.jinx) {
      setTimeout(() => {
        void engine.castJinx(lobby.id, r.jinx!.tgId, r.jinx!.target).catch((e) => {
          console.error("[demo] scripted jinx failed:", (e as Error).message);
        });
      }, BEAT * 5);
    }

    await sleep(WINDOW + 800);
    for (const beat of r.beats) {
      await engine.say(lobby, currentRound, "match", beat);
      await sleep(1200);
    }
    const status = await engine.resolveDueRound(lobby.id, r.events, r.minute);
    decided = status === "decided";
    await sleep(2500);
  }

  await engine.finish(lobby.id);
  await sleep(1500);

  for (const v of SCRIPTED_VOTES) {
    await engine.voteForfeit(lobby.id, v.tgId, v.choice);
  }
  await sleep(VOTE_WINDOW);
  await engine.closeForfeitVote(lobby.id);
  await sleep(1500);

  await engine.say(
    lobby,
    null,
    "demo",
    `Demo over. What just happened, without the theatre:\n\n` +
      `· every answer was hashed, salted and ed25519-signed by that player's own key\n` +
      `· every round's signed picks were merkle-rooted and anchored in a Solana Memo\n` +
      `· the survivor's certificate hash is in the same Memo trail\n` +
      `· the forfeit contract is notarized next to it\n\n` +
      `Nothing here can be welched, backdated or "remembered differently". ` +
      `Grab the certificate file above and check it yourself in the verify page — no wallet needed.\n\n` +
      `On a real matchday, rounds fire on the live TxLINE feed instead of a script. Same keys, same anchors, same funerals.`
  );
  await sleep(1500);

  // The finale: one full-time card with every death, every jinx, the crown.
  await engine.postGraveyardReel(lobby.id);
}

export async function demoRunningIn(chatId: number): Promise<boolean> {
  const rows = await db.query.lobbies.findMany({ where: eq(lobbies.chatId, chatId) });
  return rows.some((l) => l.state !== "finished");
}
