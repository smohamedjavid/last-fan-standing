import { describe, it, expect } from "vitest";
import { questionForTrigger, resolveQuestion, type MatchEvent } from "../src/questions.js";

const ctx = { home: "Spain", away: "Argentina", minute: 0, homeGoals: 0, awayGoals: 0 };

describe("question generation", () => {
  it("kickoff question is side-based with a deadline", () => {
    const q = questionForTrigger("kickoff", ctx);
    expect(q.kind).toBe("next_goal");
    expect(q.options.map((o) => o.key)).toEqual(["home", "away", "nobody"]);
    expect(q.deadlineMinute).toBe(25);
  });

  it("goal question deadline never crosses 90", () => {
    const q = questionForTrigger("goal", { ...ctx, minute: 85, homeGoals: 2, awayGoals: 1 });
    expect(q.deadlineMinute).toBe(90);
  });

  it("shootout is a two-way sudden-death call", () => {
    const q = questionForTrigger("shootout", { ...ctx, minute: 120 });
    expect(q.options.map((o) => o.key)).toEqual(["scored", "missed"]);
  });
});

describe("question resolution against events", () => {
  it("next_goal resolves to the scoring side inside the window", () => {
    const q = questionForTrigger("kickoff", ctx);
    const events: MatchEvent[] = [{ type: "goal", side: "home", minute: 23 }];
    expect(resolveQuestion(q, events)).toBe("home");
  });

  it("next_goal past the deadline resolves nobody", () => {
    const q = questionForTrigger("kickoff", ctx); // deadline 25'
    expect(resolveQuestion(q, [{ type: "goal", side: "away", minute: 30 }])).toBe("nobody");
  });

  it("unsettled question stays unresolved", () => {
    const q = questionForTrigger("kickoff", ctx);
    expect(resolveQuestion(q, [{ type: "card", side: "home", minute: 10 }])).toBeUndefined();
  });

  it("goals before the question was asked don't count", () => {
    const q = questionForTrigger("halftime", { ...ctx, minute: 45 }); // from 45'
    const events: MatchEvent[] = [
      { type: "goal", side: "home", minute: 23 }, // first-half goal — irrelevant
      { type: "card", side: "away", minute: 62 }, // clock passes the 60' deadline
    ];
    expect(resolveQuestion(q, events)).toBe("nobody");
  });

  it("late-drama yes/no resolves on goal or full time", () => {
    const q = questionForTrigger("late", { ...ctx, minute: 75 });
    expect(resolveQuestion(q, [{ type: "goal", side: "away", minute: 80 }])).toBe("yes");
    expect(resolveQuestion(q, [{ type: "fulltime", minute: 90 }])).toBe("no");
    expect(resolveQuestion(q, [])).toBeUndefined();
  });

  it("shootout kick resolves scored/missed", () => {
    const q = questionForTrigger("shootout", { ...ctx, minute: 120 });
    expect(resolveQuestion(q, [{ type: "shootout_kick", minute: 121, scored: true }])).toBe("scored");
    expect(resolveQuestion(q, [{ type: "shootout_kick", minute: 121, scored: false }])).toBe("missed");
  });
});
