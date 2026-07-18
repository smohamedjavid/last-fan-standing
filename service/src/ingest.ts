import { eq } from "drizzle-orm";
import { TxlineSession, TxlineRest, TxlineStream } from "txline-kit";
import { db } from "./db.js";
import { lobbies } from "./schema.js";
import type { Engine } from "./engine.js";
import type { FixtureInfo } from "./bot.js";
import type { MatchEvent, QuestionCtx, Trigger } from "./questions.js";

const ANSWER_WINDOW_MS = Number(process.env.ROUND_WINDOW_MS ?? 60_000);

interface ScoreRecord {
  FixtureId: number;
  GameState?: string;
  Action?: string;
  StatusId?: number;
  Seq?: number;
  Score?: {
    Participant1?: { Total?: { Goals?: number } };
    Participant2?: { Total?: { Goals?: number } };
  };
}

interface FixtureWatch {
  homeGoals: number;
  awayGoals: number;
  finished: boolean;
  /** everything that happened, stamped with wall-clock arrival time */
  events: Array<MatchEvent & { ts: number }>;
}

interface LobbyWatch {
  roundOpensAt: number;
  firedHalftime: boolean;
  firedLate: boolean;
  lastGoalCount: number;
}

/**
 * TxLINE → royale rounds. Live SSE for immediacy, a periodic snapshot sweep
 * for correctness (missed events, restarts). End-of-match semantics verified
 * live on 2026-07-04: GameState never changes; the real full-time signals
 * are Action "game_finalised" and StatusId 5, with a late `disconnected`
 * as the backstop. Match phase lives in StatusId, NOT GameState.
 *
 * Cards aren't carried on the devnet StablePrice feed, so live rounds stick
 * to goal/time triggers — every question stays recomputable from the feed.
 * Minutes are derived from kickoff wall-clock (logged, honest approximation).
 */
export class Ingest {
  private rest: TxlineRest;
  private session: TxlineSession;
  private fixtures = new Map<number, FixtureInfo>();
  private watches = new Map<number, FixtureWatch>();
  private lobbyWatches = new Map<string, LobbyWatch>();

  constructor(private engine: Engine) {
    this.session = new TxlineSession({ network: "devnet" });
    const jwt = process.env.TXLINE_JWT;
    const apiToken = process.env.TXLINE_API_TOKEN;
    if (jwt && apiToken) this.session.setTokens({ jwt, apiToken });
    this.rest = new TxlineRest(this.session);
  }

  async start(): Promise<void> {
    await this.syncFixtures();
    setInterval(() => void this.syncFixtures().catch(logErr), 10 * 60_000);
    setInterval(() => void this.tick().catch(logErr), 15_000);

    const stream = new TxlineStream(this.session, "/api/scores/stream");
    stream.addEventListener("data", (e) => {
      const record = (e as CustomEvent).detail?.data as ScoreRecord | undefined;
      if (record?.FixtureId) this.applyScore(record);
    });
    stream.start();
    console.log("[ingest] online");
  }

  async syncFixtures(): Promise<void> {
    const all = await this.rest.fixturesSnapshot();
    for (const f of all) {
      this.fixtures.set(f.FixtureId, {
        fixtureId: f.FixtureId,
        home: f.Participant1,
        away: f.Participant2,
        startTime: f.StartTime,
      });
    }
    console.log(`[ingest] ${this.fixtures.size} fixtures cached`);
  }

  nextFixture = async (): Promise<FixtureInfo | undefined> => {
    if (this.fixtures.size === 0) await this.syncFixtures().catch(logErr);
    return [...this.fixtures.values()]
      .filter((f) => f.startTime > Date.now())
      .sort((a, b) => a.startTime - b.startTime)[0];
  };

  private watch(fixtureId: number): FixtureWatch {
    let w = this.watches.get(fixtureId);
    if (!w) {
      w = { homeGoals: 0, awayGoals: 0, finished: false, events: [] };
      this.watches.set(fixtureId, w);
    }
    return w;
  }

  applyScore(record: ScoreRecord): void {
    const w = this.watch(record.FixtureId);
    const fx = this.fixtures.get(record.FixtureId);
    const minute = fx ? elapsedMinute(fx.startTime) : 0;

    const home = record.Score?.Participant1?.Total?.Goals ?? w.homeGoals;
    const away = record.Score?.Participant2?.Total?.Goals ?? w.awayGoals;
    if (home > w.homeGoals) {
      w.events.push({ type: "goal", side: "home", minute, ts: Date.now() });
      console.log(`[ingest] GOAL home ${record.FixtureId} ~${minute}'`);
    }
    if (away > w.awayGoals) {
      w.events.push({ type: "goal", side: "away", minute, ts: Date.now() });
      console.log(`[ingest] GOAL away ${record.FixtureId} ~${minute}'`);
    }
    w.homeGoals = home;
    w.awayGoals = away;

    const finished =
      record.Action === "game_finalised" ||
      record.StatusId === 5 ||
      (record.Action === "disconnected" && fx != null && Date.now() > fx.startTime + 100 * 60_000);
    if (finished && !w.finished) {
      w.finished = true;
      w.events.push({ type: "fulltime", minute, ts: Date.now() });
      console.log(`[ingest] FULL TIME ${record.FixtureId} (${record.Action}/${record.StatusId})`);
    }
  }

  /** The heartbeat: locks lobbies, opens/resolves rounds, finishes matches. */
  async tick(): Promise<void> {
    const open = (await db.query.lobbies.findMany()).filter(
      (l) => !l.demo && l.state !== "finished"
    );
    for (const lobby of open) {
      try {
        await this.driveLobby(lobby.id);
      } catch (e) {
        console.error(`[ingest] lobby ${lobby.id} drive failed:`, (e as Error).message?.slice(0, 200));
      }
    }
    // snapshot sweep for lobbies on live fixtures — the SSE backstop
    for (const fixtureId of new Set(open.map((l) => l.fixtureId))) {
      const fx = this.fixtures.get(fixtureId);
      if (!fx || fx.startTime > Date.now()) continue;
      try {
        const snap = (await this.rest.scoresSnapshot(fixtureId)) as ScoreRecord[];
        const latest = [...snap].sort((a, b) => (b.Seq ?? 0) - (a.Seq ?? 0))[0];
        if (latest) this.applyScore(latest);
      } catch (e) {
        // no scores yet is normal pre-match; log anything else
        const msg = (e as Error).message ?? "";
        if (!msg.includes("404")) console.error("[ingest] sweep:", msg.slice(0, 160));
      }
    }
  }

  private async driveLobby(lobbyId: string): Promise<void> {
    const lobby = (await db.query.lobbies.findFirst({ where: eq(lobbies.id, lobbyId) }))!;
    const w = this.watch(lobby.fixtureId);
    const minute = elapsedMinute(lobby.kickoff);
    let lw = this.lobbyWatches.get(lobbyId);
    if (!lw) {
      lw = { roundOpensAt: 0, firedHalftime: false, firedLate: false, lastGoalCount: 0 };
      this.lobbyWatches.set(lobbyId, lw);
    }

    // 1) kickoff: lock the lobby, open the first round
    if (lobby.state === "open" && Date.now() >= lobby.kickoff) {
      const roster = await this.engine.playersOf(lobbyId);
      if (roster.length < 2) {
        await this.engine.say(lobby, null, "abort", "Kickoff, and fewer than two in the pool. No royale today.");
        await db.update(lobbies).set({ state: "finished" }).where(eq(lobbies.id, lobbyId));
        return;
      }
      await this.engine.lock(lobbyId);
      await this.openRound(lobbyId, "kickoff", minute, w);
      return;
    }
    if (lobby.state === "open") return;

    // 2) settle whatever round is pending
    const sinceOpen = w.events.filter((e) => e.ts > lw.roundOpensAt);
    const status = await this.engine.resolveDueRound(lobbyId, stripTs(sinceOpen), minute);
    if (status === "decided" || (w.finished && status !== "waiting" && status !== "pending")) {
      if (status === "decided" || w.finished) {
        await this.engine.finish(lobbyId);
        return;
      }
    }
    if (status === "waiting" || status === "pending") return;

    // 3) no round in flight — fire the next due trigger
    const goalCount = w.events.filter((e) => e.type === "goal").length;
    let trigger: Trigger | undefined;
    if (w.finished) {
      await this.engine.finish(lobbyId);
      return;
    } else if (goalCount > lw.lastGoalCount) {
      trigger = "goal";
      lw.lastGoalCount = goalCount;
    } else if (!lw.firedHalftime && minute >= 46 && minute < 60) {
      trigger = "halftime";
      lw.firedHalftime = true;
    } else if (!lw.firedLate && minute >= 75 && minute < 90) {
      trigger = "late";
      lw.firedLate = true;
    }
    if (trigger) await this.openRound(lobbyId, trigger, minute, w);
  }

  private async openRound(
    lobbyId: string,
    trigger: Trigger,
    minute: number,
    w: FixtureWatch
  ): Promise<void> {
    const lobby = (await db.query.lobbies.findFirst({ where: eq(lobbies.id, lobbyId) }))!;
    const ctx: QuestionCtx = {
      home: lobby.home,
      away: lobby.away,
      minute,
      homeGoals: w.homeGoals,
      awayGoals: w.awayGoals,
    };
    await this.engine.openRound(lobbyId, trigger, ctx, ANSWER_WINDOW_MS);
    const lw = this.lobbyWatches.get(lobbyId)!;
    lw.roundOpensAt = Date.now();
    lw.lastGoalCount = w.events.filter((e) => e.type === "goal").length;
  }
}

function elapsedMinute(kickoff: number): number {
  return Math.max(0, Math.min(125, Math.floor((Date.now() - kickoff) / 60_000)));
}

function stripTs(events: Array<MatchEvent & { ts: number }>): MatchEvent[] {
  return events.map(({ ts: _ts, ...e }) => e);
}

function logErr(e: unknown): void {
  console.error("[ingest]", (e as Error).message?.slice(0, 200));
}
