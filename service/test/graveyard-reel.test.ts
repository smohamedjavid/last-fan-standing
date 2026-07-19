import { describe, it, expect, beforeAll } from "vitest";
import type { Bot } from "grammy";

process.env.DB_URL = ":memory:";

import { buildReel, type ReelState } from "../src/graveyard-reel.js";
import { migrate, db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { lobbies, players, messages } from "../src/schema.js";
import { eq } from "drizzle-orm";

/** A fixed, hand-built snapshot — no DB, no chain. The pure-core fixture. */
function fakeState(): ReelState {
  return {
    fixture: "Argentina v France",
    lobbyId: "reel-test",
    demo: true,
    totalRounds: 3,
    players: [
      { id: "p:1", name: "Tariq", alive: false, diedRound: 1, diedMinute: 23, fatalPick: "France" },
      { id: "p:2", name: "Nina", alive: true, isWinner: true },
      { id: "p:3", name: "Ravi", alive: false, diedRound: 2, diedMinute: 36, fatalPick: "France" },
      { id: "p:4", name: "Meg", alive: false, diedRound: 2, diedMinute: 36, fatalPick: "France" },
      { id: "p:5", name: "Sam", alive: false, diedRound: 1, diedMinute: 10 }, // silent
    ],
    jinxes: [
      { jinxerName: "Nina", targetName: "Meg", roundN: 2, landed: true },
      { jinxerName: "Ravi", targetName: "Nina", roundN: 2, landed: false },
    ],
    survivorCert: {
      names: ["Nina"],
      anchorWallet: "FakeAnchorWallet1111111111111111111111111111",
      certHashPrefix: "abc123def4567890",
      anchored: true,
    },
  };
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("buildReel — the pure full-time recap", () => {
  it("orders the dead by round, then minute, then name", () => {
    const { deaths } = buildReel(fakeState());
    expect(deaths.map((d) => d.name)).toEqual(["Sam", "Tariq", "Meg", "Ravi"]);
    // strictly non-decreasing on (round, minute)
    for (let i = 1; i < deaths.length; i++) {
      const a = deaths[i - 1];
      const b = deaths[i];
      expect(a.round < b.round || (a.round === b.round && a.minute <= b.minute)).toBe(true);
    }
  });

  it("classifies cause of death from the fatal pick", () => {
    const { deaths } = buildReel(fakeState());
    const sam = deaths.find((d) => d.name === "Sam")!;
    const tariq = deaths.find((d) => d.name === "Tariq")!;
    expect(sam.reason).toBe("silent");
    expect(sam.fatalPick).toBeUndefined();
    expect(tariq.reason).toBe("wrong");
    expect(tariq.fatalPick).toBe("France");
    // every death carries a graveside roast in the pundit voice
    for (const d of deaths) expect(d.roast.length).toBeGreaterThan(0);
  });

  it("attributes only landed jinxes to their victim", () => {
    const { deaths, jinxes } = buildReel(fakeState());
    const meg = deaths.find((d) => d.name === "Meg")!;
    const ravi = deaths.find((d) => d.name === "Ravi")!;
    expect(meg.jinxedBy).toBe("Nina"); // Nina's kiricocho landed on Meg
    expect(ravi.jinxedBy).toBeUndefined(); // Ravi's jinx on Nina never landed
    expect(jinxes).toEqual([
      { jinxer: "Nina", target: "Meg", round: 2, landed: true },
      { jinxer: "Ravi", target: "Nina", round: 2, landed: false },
    ]);
  });

  it("crowns the sole survivor with an ACCOUNT link, never a /tx/ link", () => {
    const { survivor } = buildReel(fakeState());
    expect(survivor).not.toBeNull();
    expect(survivor!.names).toEqual(["Nina"]);
    expect(survivor!.sole).toBe(true);
    expect(survivor!.certLink).toContain("/address/");
    expect(survivor!.certLink).toContain("cluster=devnet");
    expect(survivor!.certLink).not.toContain("/tx/");
  });

  it("produces a stable caption and a real PNG", () => {
    const a = buildReel(fakeState());
    const b = buildReel(fakeState());
    expect(a.caption).toBe(b.caption); // deterministic
    expect(a.caption).toContain("THE GRAVEYARD REEL");
    expect(a.caption).toContain("† R1 23' — Tariq, backed “France”");
    expect(a.caption).toContain("LAST FAN STANDING — Nina");
    expect(a.caption).toContain(a.survivor!.certLink!);
    expect(a.caption).not.toContain("/tx/");

    expect(a.imageBuffer.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(a.imageBuffer.length).toBeGreaterThan(2000);
    expect(a.imageBuffer.equals(b.imageBuffer)).toBe(true); // same state → same bytes
  });

  it("reports a total wipeout when nobody is left standing", () => {
    const wiped = fakeState();
    wiped.players = wiped.players.map((p) => ({
      ...p,
      alive: false,
      isWinner: false,
      diedRound: p.diedRound ?? 3,
      diedMinute: p.diedMinute ?? 90,
    }));
    wiped.survivorCert = undefined;
    const reel = buildReel(wiped);
    expect(reel.survivor).toBeNull();
    expect(reel.caption).toContain("NO SURVIVORS");
    expect(reel.imageBuffer.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  });
});

// --- the idempotent post guard, through the engine --------------------------

const photoSends: string[] = [];
const stubBot = {
  api: {
    sendMessage: async () => ({}),
    sendPhoto: async (_chatId: unknown, _file: unknown, opts?: { caption?: string }) => {
      photoSends.push(opts?.caption ?? "");
      return {};
    },
    sendDocument: async () => ({}),
  },
} as unknown as Bot;

const stubMemo = Object.assign(async () => "fake-sig", {
  wallet: "FakeAnchorWallet1111111111111111111111111111",
});

describe("postGraveyardReel — auto-posted exactly once", () => {
  const engine = new Engine(stubBot, stubMemo);
  let lobbyId: string;

  beforeAll(async () => {
    await migrate();
    const lobby = await engine.openLobby({
      chatId: -7,
      fixtureId: 42,
      home: "Argentina",
      away: "France",
      kickoff: Date.now() + 1000,
    });
    lobbyId = lobby.id;
    await engine.join(lobbyId, 1, "Ana");
    await engine.join(lobbyId, 2, "Bo");
    await engine.join(lobbyId, 3, "Cy");
    // Bo backed the wrong side; Cy went silent; Ana is the last fan standing.
    await db
      .update(players)
      .set({ alive: false, diedRound: 1, diedMinute: 20, fatalPick: "France" })
      .where(eq(players.id, `${lobbyId}:2`));
    await db
      .update(players)
      .set({ alive: false, diedRound: 2, diedMinute: 40 })
      .where(eq(players.id, `${lobbyId}:3`));
    await db.update(lobbies).set({ state: "finished", roundNo: 2 }).where(eq(lobbies.id, lobbyId));
  });

  it("fires once, then the persisted flag blocks every re-post", async () => {
    const first = await engine.postGraveyardReel(lobbyId);
    expect(first).toBe(true);
    expect(photoSends).toHaveLength(1);
    expect(photoSends[0]).toContain("THE GRAVEYARD REEL");
    expect(photoSends[0]).toContain("LAST FAN STANDING — Ana");

    const second = await engine.postGraveyardReel(lobbyId);
    expect(second).toBe(false);
    expect(photoSends).toHaveLength(1); // no double-post

    const lobby = (await db.query.lobbies.findFirst({ where: eq(lobbies.id, lobbyId) }))!;
    expect(lobby.reelPosted).toBe(true);

    const logged = (await db.query.messages.findMany({ where: eq(messages.lobbyId, lobbyId) })).filter(
      (m) => m.kind === "photo" && m.body.includes("THE GRAVEYARD REEL")
    );
    expect(logged).toHaveLength(1);
  });
});
