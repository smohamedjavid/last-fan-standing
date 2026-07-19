import { funeralLine } from "./pundit.js";
import { accountLink } from "./memo.js";
import { renderGraveyardReel, type ReelCardData } from "./wallchart.js";

/**
 * The graveyard reel — the full-time recap the group screenshots.
 *
 * `buildReel` is pure and deterministic: given a plain snapshot of the pool it
 * composes the ordered list of deaths (each with its fatal pick and a graveside
 * roast in the pundit's template voice), the kiricocho ledger, and the crowned
 * survivor with the on-chain certificate ACCOUNT link (never a /tx/ link). It
 * returns both a tall hand-inked image (via the wall-chart renderer) and a
 * compact caption for the group message. No I/O, no clock, no chain — a judge
 * can recompute the whole thing from the round records.
 */

export interface ReelInputPlayer {
  id: string;
  name: string;
  alive: boolean;
  diedRound?: number;
  diedMinute?: number;
  /** the fatal pick's label; absent means they went silent */
  fatalPick?: string;
  /** alive at full time = crowned survivor */
  isWinner?: boolean;
}

export interface ReelInputJinx {
  jinxerName: string;
  targetName: string;
  roundN: number;
  /** true when the target actually died the round it was cast for */
  landed: boolean;
}

export interface ReelState {
  fixture: string;
  lobbyId: string;
  demo: boolean;
  totalRounds: number;
  players: ReelInputPlayer[];
  jinxes: ReelInputJinx[];
  survivorCert?: {
    /** survivor name(s) — one for a sole survivor, more for co-survivors */
    names: string[];
    /** anchor wallet whose account page proves the cert on devnet */
    anchorWallet?: string;
    certHashPrefix?: string;
    anchored?: boolean;
  };
}

export type DeathReason = "wrong" | "silent";

export interface ReelDeath {
  name: string;
  round: number;
  minute: number;
  fatalPick?: string;
  reason: DeathReason;
  roast: string;
  jinxedBy?: string;
}

export interface ReelJinxLine {
  jinxer: string;
  target: string;
  round: number;
  landed: boolean;
}

export interface ReelSurvivor {
  names: string[];
  sole: boolean;
  /** explorer ACCOUNT link for the anchor wallet — never a /tx/ link */
  certLink?: string;
}

export interface Reel {
  imageBuffer: Buffer;
  caption: string;
  /** null on a total wipeout */
  survivor: ReelSurvivor | null;
  /** in death order: earliest round/minute first */
  deaths: ReelDeath[];
  jinxes: ReelJinxLine[];
}

/** Death order: earliest round, then earliest minute, then name. */
function byDeathOrder(a: ReelInputPlayer, b: ReelInputPlayer): number {
  return (
    (a.diedRound ?? 0) - (b.diedRound ?? 0) ||
    (a.diedMinute ?? 0) - (b.diedMinute ?? 0) ||
    a.name.localeCompare(b.name)
  );
}

export function buildReel(state: ReelState): Reel {
  const deaths: ReelDeath[] = state.players
    .filter((p) => !p.alive && p.diedRound != null)
    .sort(byDeathOrder)
    .map((p) => {
      const reason: DeathReason = p.fatalPick ? "wrong" : "silent";
      const jinx = state.jinxes.find((j) => j.landed && j.targetName === p.name);
      const roast = funeralLine({
        lobbyId: state.lobbyId,
        roundN: p.diedRound!,
        name: p.name,
        reason,
        pickLabel: p.fatalPick,
        minute: p.diedMinute ?? 0,
      });
      return {
        name: p.name,
        round: p.diedRound!,
        minute: p.diedMinute ?? 0,
        fatalPick: p.fatalPick,
        reason,
        roast,
        jinxedBy: jinx?.jinxerName,
      };
    });

  const jinxes: ReelJinxLine[] = state.jinxes.map((j) => ({
    jinxer: j.jinxerName,
    target: j.targetName,
    round: j.roundN,
    landed: j.landed,
  }));

  const winners = state.players.filter((p) => p.isWinner);
  const survivor: ReelSurvivor | null =
    winners.length === 0
      ? null
      : {
          names: winners.map((w) => w.name),
          sole: winners.length === 1,
          certLink: state.survivorCert?.anchorWallet
            ? accountLink(state.survivorCert.anchorWallet)
            : undefined,
        };

  const card: ReelCardData = {
    fixture: state.fixture,
    lobbyId: state.lobbyId,
    demo: state.demo,
    totalRounds: state.totalRounds,
    tombs: deaths.map((d) => ({
      name: d.name,
      round: d.round,
      minute: d.minute,
      fatalPick: d.fatalPick,
      roast: d.roast,
      jinxedBy: d.jinxedBy,
    })),
    jinxes,
    survivors: survivor?.names ?? [],
    certHashPrefix: state.survivorCert?.certHashPrefix,
    anchored: state.survivorCert?.anchored ?? false,
  };

  return {
    imageBuffer: renderGraveyardReel(card),
    caption: buildCaption(state, deaths, jinxes, survivor),
    survivor,
    deaths,
    jinxes,
  };
}

/** The compact group-message caption. Deterministic — stable across renders. */
function buildCaption(
  state: ReelState,
  deaths: ReelDeath[],
  jinxes: ReelJinxLine[],
  survivor: ReelSurvivor | null
): string {
  const lines: string[] = [];
  lines.push("FULL TIME — THE GRAVEYARD REEL");
  lines.push(`${state.fixture}${state.demo ? " · DEMO" : ""}`);
  lines.push("");

  if (deaths.length) {
    lines.push("The fallen, in order:");
    const shown = deaths.slice(0, 14);
    for (const d of shown) {
      const cause = d.fatalPick ? `backed “${d.fatalPick}”` : "went silent";
      const jinx = d.jinxedBy ? ` · kiricocho by ${d.jinxedBy}` : "";
      lines.push(`† R${d.round} ${d.minute}' — ${d.name}, ${cause}${jinx}`);
    }
    if (deaths.length > shown.length) {
      lines.push(`† …and ${deaths.length - shown.length} more under the stones`);
    }
  } else {
    lines.push("Nobody fell — a survivor pool with no funerals, unheard of.");
  }

  if (jinxes.length) {
    lines.push("");
    lines.push("KIRICOCHO");
    for (const j of jinxes) {
      lines.push(`${j.jinxer} → ${j.target} (R${j.round}): ${j.landed ? "landed" : "no effect"}`);
    }
  }

  lines.push("");
  if (survivor) {
    lines.push(
      survivor.sole
        ? `LAST FAN STANDING — ${survivor.names[0]}`
        : `CO-SURVIVORS — ${survivor.names.join(", ")}`
    );
    if (survivor.certLink) {
      lines.push("Survivor certificate anchored on Solana devnet:");
      lines.push(survivor.certLink);
    } else {
      lines.push("Survivor certificate issued.");
    }
  } else {
    lines.push("NO SURVIVORS — total wipeout. The chart is the only winner.");
  }

  return lines.join("\n");
}
