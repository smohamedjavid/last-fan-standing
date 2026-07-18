/**
 * The sudden-death core. Pure functions only — no I/O, no clock, no chain.
 * Everything here is recomputable by a judge from the round records.
 *
 * Rules:
 *  - Wrong answer  → eliminated.
 *  - Silent answer → eliminated, UNLESS the round grants grace (round 1 by
 *    default — people are still finding their thumbs).
 *  - If a round would kill every remaining player, the round is VOIDED and
 *    nobody dies (a survivor pool with no survivors is just a graveyard).
 *  - Last player alive wins. If the match ends with several still standing,
 *    they are co-survivors — each gets a certificate.
 */

export type ElimReason = "wrong" | "silent";

export interface Elimination {
  playerId: string;
  reason: ElimReason;
  /** what they picked, if they picked at all */
  pick?: string;
}

export interface RoundResolution {
  eliminated: Elimination[];
  survivors: string[];
  /** true when the round would have wiped everyone and was annulled */
  voided: boolean;
}

export function resolveRound(opts: {
  alive: string[];
  /** playerId → option key they answered */
  answers: Map<string, string>;
  correct: string;
  /** silence forgiven this round (grace) */
  graceForSilent?: boolean;
}): RoundResolution {
  const { alive, answers, correct, graceForSilent = false } = opts;
  const eliminated: Elimination[] = [];

  for (const playerId of alive) {
    const pick = answers.get(playerId);
    if (pick === undefined) {
      if (!graceForSilent) eliminated.push({ playerId, reason: "silent" });
      continue;
    }
    if (pick !== correct) eliminated.push({ playerId, reason: "wrong", pick });
  }

  if (eliminated.length >= alive.length && alive.length > 0) {
    // total wipe → void the round, everyone lives to be wrong again
    return { eliminated: [], survivors: [...alive], voided: true };
  }

  const dead = new Set(eliminated.map((e) => e.playerId));
  return {
    eliminated,
    survivors: alive.filter((p) => !dead.has(p)),
    voided: false,
  };
}

// ---------------------------------------------------------------------------
// KIRICOCHO — the jinx. Once per match, living players only, cast before a
// round resolves. If the cursed player dies that round, the jinxer gets the
// credit mark on the wall chart. Zero effect on scoring — pure drama.
// ---------------------------------------------------------------------------

export interface Jinx {
  jinxerId: string;
  targetId: string;
  roundN: number;
}

export type JinxRejection =
  | "jinxer-dead"
  | "target-dead"
  | "already-used"
  | "self-jinx"
  | "target-unknown";

export function canJinx(opts: {
  jinxerId: string;
  targetId: string;
  alive: string[];
  allPlayers: string[];
  priorJinxes: Jinx[];
}): { ok: true } | { ok: false; reason: JinxRejection } {
  const { jinxerId, targetId, alive, allPlayers, priorJinxes } = opts;
  if (jinxerId === targetId) return { ok: false, reason: "self-jinx" };
  if (!allPlayers.includes(targetId)) return { ok: false, reason: "target-unknown" };
  if (!alive.includes(jinxerId)) return { ok: false, reason: "jinxer-dead" };
  if (!alive.includes(targetId)) return { ok: false, reason: "target-dead" };
  if (priorJinxes.some((j) => j.jinxerId === jinxerId))
    return { ok: false, reason: "already-used" };
  return { ok: true };
}

/** Which jinxes cast on this round landed (their target died this round)? */
export function creditJinxes(jinxes: Jinx[], roundN: number, eliminated: Elimination[]): Jinx[] {
  const dead = new Set(eliminated.map((e) => e.playerId));
  return jinxes.filter((j) => j.roundN === roundN && dead.has(j.targetId));
}

// ---------------------------------------------------------------------------
// Endgame
// ---------------------------------------------------------------------------

export function isDecided(alive: string[]): boolean {
  return alive.length <= 1;
}

/** Survivors at full time all get crowned; sole survivor is the clean win. */
export function crown(alive: string[]): { winners: string[]; sole: boolean } {
  return { winners: [...alive], sole: alive.length === 1 };
}
