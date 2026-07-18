/**
 * Sudden-death questions. Every question is answerable from TxLINE match
 * stats alone — a judge can recompute every elimination from the feed. No
 * vibes, no editorial calls, no "well actually".
 *
 * A question is generated when a trigger fires (kickoff, goal, card,
 * halftime, 75', full-time, shootout kick) and resolved later against the
 * events that actually happened.
 */

export type Trigger =
  | "kickoff"
  | "goal"
  | "card"
  | "halftime"
  | "late" // the 75' late-drama window
  | "fulltime"
  | "shootout";

export interface Option {
  key: string;
  label: string;
}

export type QuestionKind =
  | "next_goal" // which side scores next before a deadline (or nobody)
  | "next_card" // which side is carded next before a deadline (or nobody)
  | "goal_before" // yes/no: any goal before deadline minute
  | "kick_outcome"; // shootout kick: scored or missed

export interface Question {
  kind: QuestionKind;
  text: string;
  options: Option[];
  /** minute the window closes for time-bounded kinds */
  deadlineMinute?: number;
  /** minute the question was asked (events before this don't count) */
  fromMinute: number;
}

/** A match event as derived from the TxLINE feed (or the demo script). */
export interface MatchEvent {
  type: "goal" | "card" | "halftime" | "fulltime" | "shootout_kick";
  /** home | away — for goals/cards */
  side?: "home" | "away";
  minute: number;
  /** shootout kicks only */
  scored?: boolean;
  /** free-text flavour for the group message (scorer etc.) */
  note?: string;
}

export interface QuestionCtx {
  home: string;
  away: string;
  minute: number;
  homeGoals: number;
  awayGoals: number;
}

/** Build the question for a fired trigger. Deterministic: same ctx → same q. */
export function questionForTrigger(trigger: Trigger, ctx: QuestionCtx): Question {
  const { home, away, minute } = ctx;
  switch (trigger) {
    case "kickoff": {
      const deadline = 25;
      return {
        kind: "next_goal",
        text: `Opening question. First goal before ${deadline}' — who scores it?`,
        options: sideOptions(home, away, `No goal before ${deadline}'`),
        deadlineMinute: deadline,
        fromMinute: 0,
      };
    }
    case "goal": {
      const deadline = Math.min(minute + 20, 90);
      return {
        kind: "next_goal",
        text:
          `${ctx.home} ${ctx.homeGoals}–${ctx.awayGoals} ${ctx.away}. ` +
          `Next goal before ${deadline}' — who gets it?`,
        options: sideOptions(home, away, `Nobody before ${deadline}'`),
        deadlineMinute: deadline,
        fromMinute: minute,
      };
    }
    case "card": {
      const deadline = Math.min(minute + 20, 90);
      return {
        kind: "next_card",
        text: `Cards are out. Next booking before ${deadline}' — which side?`,
        options: sideOptions(home, away, `Nobody before ${deadline}'`),
        deadlineMinute: deadline,
        fromMinute: minute,
      };
    }
    case "halftime": {
      const deadline = 60;
      return {
        kind: "next_goal",
        text: `Half-time. First goal of the second half before ${deadline}' — who scores?`,
        options: sideOptions(home, away, `No goal before ${deadline}'`),
        deadlineMinute: deadline,
        fromMinute: 45,
      };
    }
    case "late": {
      return {
        kind: "goal_before",
        text: `75 minutes gone. Is there another goal before full time?`,
        options: [
          { key: "yes", label: "Yes — late drama" },
          { key: "no", label: "No — shop's shut" },
        ],
        deadlineMinute: 120, // covers extra time; FT event resolves it
        fromMinute: 75,
      };
    }
    case "fulltime":
    case "shootout": {
      return {
        kind: "kick_outcome",
        text: `Sudden death. Next kick from the spot — does it go in?`,
        options: [
          { key: "scored", label: "Scored" },
          { key: "missed", label: "Missed / saved" },
        ],
        fromMinute: minute,
      };
    }
  }
}

function sideOptions(home: string, away: string, nobodyLabel: string): Option[] {
  return [
    { key: "home", label: home },
    { key: "away", label: away },
    { key: "nobody", label: nobodyLabel },
  ];
}

/**
 * Resolve a question against what actually happened. Returns the correct
 * option key, or undefined if the evidence can't settle it yet.
 */
export function resolveQuestion(q: Question, events: MatchEvent[]): string | undefined {
  const after = events.filter((e) => e.minute >= q.fromMinute);
  switch (q.kind) {
    case "next_goal": {
      const goal = after.find((e) => e.type === "goal" && e.minute < (q.deadlineMinute ?? 999));
      if (goal?.side) return goal.side;
      // no qualifying goal — settled once the clock passes the deadline or FT
      if (clockPassed(after, q.deadlineMinute)) return "nobody";
      return undefined;
    }
    case "next_card": {
      const card = after.find((e) => e.type === "card" && e.minute < (q.deadlineMinute ?? 999));
      if (card?.side) return card.side;
      if (clockPassed(after, q.deadlineMinute)) return "nobody";
      return undefined;
    }
    case "goal_before": {
      const goal = after.find((e) => e.type === "goal" && e.minute < (q.deadlineMinute ?? 999));
      if (goal) return "yes";
      if (after.some((e) => e.type === "fulltime")) return "no";
      return undefined;
    }
    case "kick_outcome": {
      const kick = after.find((e) => e.type === "shootout_kick");
      if (kick) return kick.scored ? "scored" : "missed";
      return undefined;
    }
  }
}

/** Has the match clock provably passed the deadline (event at/past it, or FT)? */
function clockPassed(events: MatchEvent[], deadline?: number): boolean {
  if (deadline === undefined) return events.some((e) => e.type === "fulltime");
  return events.some((e) => e.type === "fulltime" || e.minute >= deadline);
}
