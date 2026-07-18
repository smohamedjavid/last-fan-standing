import { describe, it, expect, beforeAll } from "vitest";
import type { Bot } from "grammy";

process.env.DB_URL = ":memory:";

import { migrate, db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { verifySig } from "../src/keys.js";
import { certHash, type SurvivorCert } from "../src/cert.js";
import { rounds, answers, certs, jinxes } from "../src/schema.js";
import { eq } from "drizzle-orm";

/** Telegram stub: swallows sends, records nothing. The engine never knows. */
const stubBot = {
  api: {
    sendMessage: async () => ({}),
    sendPhoto: async () => ({}),
    sendDocument: async () => ({}),
  },
} as unknown as Bot;

/** Memo stub: fake anchors, real payload shape. */
const memoLog: string[] = [];
const stubMemo = Object.assign(
  async (json: string) => {
    memoLog.push(json);
    return `fake-sig-${memoLog.length}`;
  },
  { wallet: "FakeAnchorWallet1111111111111111111111111111" }
);

describe("a full royale, end to end (no Telegram, no chain)", () => {
  const engine = new Engine(stubBot, stubMemo);
  let lobbyId: string;

  beforeAll(async () => {
    await migrate();
    await migrate(); // migration idempotency — same schema twice, no throw

    const lobby = await engine.openLobby({
      chatId: -1,
      fixtureId: 18257739,
      home: "Spain",
      away: "Argentina",
      kickoff: Date.now() + 1000,
    });
    lobbyId = lobby.id;
    expect((await engine.join(lobbyId, 10, "Sarah")).status).toBe("joined");
    expect((await engine.join(lobbyId, 11, "Dave")).status).toBe("joined");
    expect((await engine.join(lobbyId, 12, "Priya")).status).toBe("joined");
    expect((await engine.join(lobbyId, 10, "Sarah")).status).toBe("already");
    await engine.lock(lobbyId);
    expect((await engine.join(lobbyId, 13, "Late Larry")).status).toBe("locked");
  });

  it("round 1: wrong pick dies, grace saves the silent", async () => {
    await engine.openRound(
      lobbyId,
      "kickoff",
      { home: "Spain", away: "Argentina", minute: 0, homeGoals: 0, awayGoals: 0 },
      50 // tiny window so the test resolves fast
    );
    expect(await engine.answer(lobbyId, 1, 10, "home")).toBe("ok");
    expect(await engine.answer(lobbyId, 1, 11, "away")).toBe("ok");
    // Priya stays silent — round 1 grace
    await new Promise((r) => setTimeout(r, 80));
    expect(await engine.answer(lobbyId, 1, 10, "away")).toBe("late");

    const status = await engine.resolveDueRound(
      lobbyId,
      [{ type: "goal", side: "home", minute: 12 }],
      12
    );
    expect(status).toBe("resolved");

    const roster = await engine.playersOf(lobbyId);
    const dave = roster.find((p) => p.name === "Dave")!;
    const priya = roster.find((p) => p.name === "Priya")!;
    expect(dave.alive).toBe(false);
    expect(dave.fatalPick).toBe("Argentina");
    expect(priya.alive).toBe(true); // grace

    // the round was anchored: merkle root stored + memo sent
    const r1 = (await db.query.rounds.findFirst({ where: eq(rounds.id, `${lobbyId}:1`) }))!;
    expect(r1.merkleRoot).toBeTruthy();
    expect(r1.memoSig).toBe("fake-sig-1");
    expect(memoLog[0]).toContain('"p":"lfs/round/v1"');

    // stored answers carry real signatures by each player's own key
    const stored = await db.query.answers.findMany({ where: eq(answers.roundId, r1.id) });
    for (const a of stored) {
      const player = roster.find((p) => p.id === a.playerId)!;
      expect(verifySig(a.commitHash, a.sig, player.pubkey!)).toBe(true);
    }
  });

  it("jinx: dead can't cast, living cast once, credit lands on the kill", async () => {
    const dead = await engine.castJinx(lobbyId, 11, "Priya");
    expect(dead.ok).toBe(false); // Dave is dead

    const cast = await engine.castJinx(lobbyId, 10, "Priya");
    expect(cast.ok).toBe(true);
    const again = await engine.castJinx(lobbyId, 10, "Priya");
    expect(again.ok).toBe(false); // one per match

    await engine.openRound(
      lobbyId,
      "goal",
      { home: "Spain", away: "Argentina", minute: 12, homeGoals: 1, awayGoals: 0 },
      50
    );
    expect(await engine.answer(lobbyId, 2, 10, "home")).toBe("ok");
    expect(await engine.answer(lobbyId, 2, 12, "away")).toBe("ok"); // Priya's fatal pick
    await new Promise((r) => setTimeout(r, 80));

    const status = await engine.resolveDueRound(
      lobbyId,
      [{ type: "goal", side: "home", minute: 30 }],
      30
    );
    expect(status).toBe("decided"); // only Sarah left

    const jx = await db.query.jinxes.findMany({ where: eq(jinxes.lobbyId, lobbyId) });
    expect(jx).toHaveLength(1);
    expect(jx[0].credited).toBe(true); // Sarah's kiricocho landed on Priya
  });

  it("endgame: certificate is issued, anchored, and recomputable", async () => {
    await engine.finish(lobbyId);
    const rows = await db.query.certs.findMany({ where: eq(certs.lobbyId, lobbyId) });
    expect(rows).toHaveLength(1);
    const cert = JSON.parse(rows[0].certJson) as SurvivorCert;
    expect(cert.survivor.name).toBe("Sarah");
    expect(cert.rounds).toHaveLength(2); // both her correct signed picks
    expect(cert.rounds.map((r) => r.correct)).toEqual(["home", "home"]);
    // hash in the DB matches an independent recompute — the verify-page contract
    expect(certHash(cert)).toBe(rows[0].certHash);
    // cert was anchored after the two round memos
    expect(rows[0].memoSig).toBe("fake-sig-3");
    expect(memoLog[2]).toContain(rows[0].certHash);
    // signatures inside the cert verify against the survivor's pubkey
    for (const r of cert.rounds) {
      expect(verifySig(r.commitHash, r.sig, cert.survivor.pubkey)).toBe(true);
    }
  });

  it("forfeit: first-out is on the hook, group vote is tallied and notarized", async () => {
    // Dave died first (round 1) — the vote opened during finish()
    expect(await engine.voteForfeit(lobbyId, 10, "name")).toBe("ok");
    expect(await engine.voteForfeit(lobbyId, 12, "name")).toBe("ok");
    expect(await engine.voteForfeit(lobbyId, 11, "biscuits")).toBe("ok");
    expect(await engine.voteForfeit(lobbyId, 10, "nonsense")).toBe("bad-choice");
    await engine.closeForfeitVote(lobbyId);

    const lobby = (await db.query.lobbies.findMany()).find((l) => l.id === lobbyId)!;
    expect(lobby.forfeitTemplate).toBe("name");
    expect(lobby.forfeitState).toBe("chosen");
    expect(lobby.forfeitMemoSig).toBe("fake-sig-4");
    expect(memoLog[3]).toContain('"p":"lfs/forfeit/v1"');

    // only the debtor can settle
    expect(await engine.submitProof(lobbyId, 10)).toContain("Only the debtor");
    expect(await engine.submitProof(lobbyId, 11)).toBe("Debt settled.");
  });
});
