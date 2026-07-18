import { describe, it, expect } from "vitest";
import { resolveRound, canJinx, creditJinxes, crown, type Jinx } from "../src/royale.js";

describe("elimination logic", () => {
  const alive = ["a", "b", "c", "d"];

  it("kills wrong answers, spares right ones", () => {
    const r = resolveRound({
      alive,
      answers: new Map([
        ["a", "home"],
        ["b", "away"],
        ["c", "home"],
        ["d", "home"],
      ]),
      correct: "home",
    });
    expect(r.voided).toBe(false);
    expect(r.eliminated).toEqual([{ playerId: "b", reason: "wrong", pick: "away" }]);
    expect(r.survivors).toEqual(["a", "c", "d"]);
  });

  it("kills silence when there is no grace", () => {
    const r = resolveRound({
      alive,
      answers: new Map([
        ["a", "home"],
        ["b", "home"],
        ["c", "home"],
      ]),
      correct: "home",
    });
    expect(r.eliminated).toEqual([{ playerId: "d", reason: "silent" }]);
  });

  it("forgives silence under grace, still kills wrong answers", () => {
    const r = resolveRound({
      alive,
      answers: new Map([
        ["a", "away"],
        ["b", "home"],
      ]),
      correct: "home",
      graceForSilent: true,
    });
    expect(r.eliminated).toEqual([{ playerId: "a", reason: "wrong", pick: "away" }]);
    expect(r.survivors).toEqual(["b", "c", "d"]);
  });

  it("voids the round instead of wiping everyone", () => {
    const r = resolveRound({
      alive,
      answers: new Map([
        ["a", "away"],
        ["b", "away"],
      ]),
      correct: "home",
    });
    expect(r.voided).toBe(true);
    expect(r.eliminated).toEqual([]);
    expect(r.survivors).toEqual(alive);
  });

  it("a lone survivor answering wrong is also a wipe → void", () => {
    const r = resolveRound({
      alive: ["a"],
      answers: new Map([["a", "away"]]),
      correct: "home",
    });
    expect(r.voided).toBe(true);
    expect(r.survivors).toEqual(["a"]);
  });
});

describe("kiricocho rules", () => {
  const alive = ["a", "b", "c"];
  const all = ["a", "b", "c", "dead1"];

  const base = { alive, allPlayers: all, priorJinxes: [] as Jinx[] };

  it("living player may jinx a living rival once", () => {
    expect(canJinx({ ...base, jinxerId: "a", targetId: "b" })).toEqual({ ok: true });
  });

  it("dead players cannot jinx", () => {
    expect(canJinx({ ...base, jinxerId: "dead1", targetId: "b" })).toEqual({
      ok: false,
      reason: "jinxer-dead",
    });
  });

  it("cannot jinx the dead", () => {
    expect(canJinx({ ...base, jinxerId: "a", targetId: "dead1" })).toEqual({
      ok: false,
      reason: "target-dead",
    });
  });

  it("one jinx per match, ever", () => {
    const prior: Jinx[] = [{ jinxerId: "a", targetId: "c", roundN: 1 }];
    expect(canJinx({ ...base, priorJinxes: prior, jinxerId: "a", targetId: "b" })).toEqual({
      ok: false,
      reason: "already-used",
    });
  });

  it("no self-jinx", () => {
    expect(canJinx({ ...base, jinxerId: "a", targetId: "a" })).toEqual({
      ok: false,
      reason: "self-jinx",
    });
  });

  it("credits only jinxes whose target died in that round", () => {
    const jinxes: Jinx[] = [
      { jinxerId: "a", targetId: "b", roundN: 3 },
      { jinxerId: "c", targetId: "a", roundN: 3 },
      { jinxerId: "x", targetId: "b", roundN: 2 }, // cast an earlier round — no credit
    ];
    const credited = creditJinxes(jinxes, 3, [{ playerId: "b", reason: "wrong", pick: "away" }]);
    expect(credited).toEqual([{ jinxerId: "a", targetId: "b", roundN: 3 }]);
  });
});

describe("endgame", () => {
  it("sole survivor takes a clean crown", () => {
    expect(crown(["a"])).toEqual({ winners: ["a"], sole: true });
  });
  it("multiple survivors at full time co-crown", () => {
    expect(crown(["a", "b"])).toEqual({ winners: ["a", "b"], sole: false });
  });
});
