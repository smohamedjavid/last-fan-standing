import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Bot } from "grammy";
import { InlineKeyboard, InputFile } from "grammy";
import { db } from "./db.js";
import { lobbies, players, rounds, answers, jinxes, certs, forfeitVotes, messages } from "./schema.js";
import {
  resolveRound as resolveElimination,
  canJinx,
  creditJinxes,
  crown,
  type Jinx,
} from "./royale.js";
import {
  questionForTrigger,
  resolveQuestion,
  type MatchEvent,
  type Question,
  type QuestionCtx,
  type Trigger,
} from "./questions.js";
import { mintKeypair, newSalt, pickCommitHash, signHash } from "./keys.js";
import { leafHash, merkleRoot } from "./merkle.js";
import { certHash, certMemoPayload, type SurvivorCert, type CertRound } from "./cert.js";
import { roundMemoPayload, forfeitMemoPayload, accountLink, type MemoSender } from "./memo.js";
import {
  funeralLine,
  jinxCastLine,
  jinxCreditLine,
  hauntLine,
  coronationLine,
  Pundit,
} from "./pundit.js";
import { renderWallChart, renderTombstoneCard, type ChartData } from "./wallchart.js";

/** Round 1 forgives silence — people are still finding their thumbs. */
const GRACE_ROUND_1 = true;

export const FORFEIT_TEMPLATES: Record<string, string> = {
  name: "Display-name rule — 24 hours under a name of the winner's choosing",
  pic: "Profile-pic rule — the winner picks the group photo tribute for 24 hours",
  biscuits: "The biscuits IOU — brings the good ones to the next watch-along",
};

export type LobbyRow = typeof lobbies.$inferSelect;
export type PlayerRow = typeof players.$inferSelect;
export type RoundRow = typeof rounds.$inferSelect;

export class Engine {
  readonly pundit = new Pundit();

  constructor(
    private bot: Bot,
    readonly memo: MemoSender | null
  ) {}

  // -- lobby ----------------------------------------------------------------

  async openLobby(opts: {
    chatId: number;
    fixtureId: number;
    home: string;
    away: string;
    kickoff: number;
    demo?: boolean;
  }): Promise<LobbyRow> {
    const id = randomBytes(4).toString("hex");
    await db.insert(lobbies).values({
      id,
      chatId: opts.chatId,
      fixtureId: opts.fixtureId,
      home: opts.home,
      away: opts.away,
      kickoff: opts.kickoff,
      demo: opts.demo ?? false,
      createdAt: Date.now(),
    });
    const lobby = (await db.query.lobbies.findFirst({ where: eq(lobbies.id, id) }))!;
    const kb = new InlineKeyboard().text("I'm in — deal me a key", `j:${id}`);
    await this.say(
      lobby,
      null,
      "lobby",
      `LAST FAN STANDING${lobby.demo ? " · DEMO" : ""}\n` +
        `${lobby.home} v ${lobby.away}\n\n` +
        `One pool. Sudden-death questions on live match events. Wrong or silent = out. ` +
        `Last fan standing takes the certificate; first out takes the forfeit.\n\n` +
        `Joining mints you a Solana key that signs every pick you make — nobody rewrites history in this chat.\n` +
        `Lobby locks at kickoff.`,
      kb
    );
    return lobby;
  }

  async join(
    lobbyId: string,
    tgId: number,
    name: string,
    scripted = false
  ): Promise<{ status: "joined" | "already" | "locked" | "no-lobby"; pubkey?: string }> {
    const lobby = await db.query.lobbies.findFirst({ where: eq(lobbies.id, lobbyId) });
    if (!lobby) return { status: "no-lobby" };
    if (lobby.state !== "open") return { status: "locked" };
    const id = `${lobbyId}:${tgId}`;
    const existing = await db.query.players.findFirst({ where: eq(players.id, id) });
    if (existing) return { status: "already", pubkey: existing.pubkey ?? undefined };
    const kp = mintKeypair();
    await db.insert(players).values({
      id,
      lobbyId,
      tgId,
      name,
      pubkey: kp.pubkey,
      secret: kp.secret,
      scripted,
      joinedAt: Date.now(),
    });
    return { status: "joined", pubkey: kp.pubkey };
  }

  async lock(lobbyId: string): Promise<void> {
    await db.update(lobbies).set({ state: "locked" }).where(eq(lobbies.id, lobbyId));
    const lobby = (await db.query.lobbies.findFirst({ where: eq(lobbies.id, lobbyId) }))!;
    const roster = await this.playersOf(lobbyId);
    await this.say(
      lobby,
      null,
      "lock",
      `Lobby locked. ${roster.length} in the pool: ${roster.map((p) => p.name).join(", ")}.\n` +
        `Rounds fire on real match events. Round 1 forgives silence — after that, a closed mouth is a wrong answer.`
    );
  }

  // -- rounds ---------------------------------------------------------------

  async openRound(
    lobbyId: string,
    trigger: Trigger,
    ctx: QuestionCtx,
    windowMs: number
  ): Promise<{ round: RoundRow; question: Question }> {
    const lobby = (await db.query.lobbies.findFirst({ where: eq(lobbies.id, lobbyId) }))!;
    const n = lobby.roundNo + 1;
    const question = questionForTrigger(trigger, ctx);
    const now = Date.now();
    await db.insert(rounds).values({
      id: `${lobbyId}:${n}`,
      lobbyId,
      n,
      trigger,
      questionJson: JSON.stringify(question),
      opensAt: now,
      closesAt: now + windowMs,
    });
    await db.update(lobbies).set({ roundNo: n, state: "live" }).where(eq(lobbies.id, lobbyId));

    const kb = new InlineKeyboard();
    for (const o of question.options) kb.text(o.label, `a:${lobbyId}:${n}:${o.key}`);
    const aliveCount = (await this.playersOf(lobbyId)).filter((p) => p.alive).length;
    await this.say(
      lobby,
      n,
      "round",
      `ROUND ${n} — sudden death (${aliveCount} alive)\n\n${question.text}\n\n` +
        `${Math.round(windowMs / 1000)} seconds. Wrong or silent = tombstone.` +
        (n === 1 && GRACE_ROUND_1 ? ` (Round 1 only: silence is forgiven.)` : ``),
      kb
    );
    const round = (await db.query.rounds.findFirst({ where: eq(rounds.id, `${lobbyId}:${n}`) }))!;
    return { round, question };
  }

  /** Record (or update) a signed answer while the window is open. */
  async answer(
    lobbyId: string,
    n: number,
    tgId: number,
    option: string
  ): Promise<"ok" | "updated" | "late" | "dead" | "not-playing" | "no-round"> {
    const round = await db.query.rounds.findFirst({ where: eq(rounds.id, `${lobbyId}:${n}`) });
    if (!round) return "no-round";
    if (round.state !== "open" || Date.now() > round.closesAt) return "late";
    const player = await db.query.players.findFirst({
      where: eq(players.id, `${lobbyId}:${tgId}`),
    });
    if (!player) return "not-playing";
    if (!player.alive) return "dead";

    const salt = newSalt();
    const commitHash = pickCommitHash({ lobbyId, roundN: n, playerId: player.id, option, salt });
    const sig = player.secret ? signHash(commitHash, player.secret) : "";
    const existing = await db.query.answers.findFirst({
      where: and(eq(answers.roundId, round.id), eq(answers.playerId, player.id)),
    });
    await db
      .insert(answers)
      .values({ roundId: round.id, playerId: player.id, option, salt, commitHash, sig, answeredAt: Date.now() })
      .onConflictDoUpdate({
        target: [answers.roundId, answers.playerId],
        set: { option, salt, commitHash, sig, answeredAt: Date.now() },
      });
    return existing ? "updated" : "ok";
  }

  async closeRound(lobbyId: string, n: number): Promise<void> {
    await db
      .update(rounds)
      .set({ state: "closed" })
      .where(and(eq(rounds.id, `${lobbyId}:${n}`), eq(rounds.state, "open")));
  }

  /**
   * Try to settle the lobby's latest round against what actually happened.
   * `events` must be events observed since the round opened (drivers filter).
   * Returns what the driver needs to know to keep the match moving.
   */
  async resolveDueRound(
    lobbyId: string,
    events: MatchEvent[],
    minute: number
  ): Promise<"none" | "waiting" | "pending" | "resolved" | "decided"> {
    const lobby = (await db.query.lobbies.findFirst({ where: eq(lobbies.id, lobbyId) }))!;
    const round = await db.query.rounds.findFirst({
      where: eq(rounds.id, `${lobbyId}:${lobby.roundNo}`),
    });
    if (!round || round.state === "resolved" || round.state === "voided") return "none";
    if (Date.now() < round.closesAt) return "waiting";
    if (round.state === "open") await this.closeRound(lobbyId, round.n);

    const question = JSON.parse(round.questionJson) as Question;
    const correct = resolveQuestion(question, events);
    if (correct === undefined) return "pending";

    await this.settleRound(lobby, round, question, correct, minute);
    const stillAlive = (await this.playersOf(lobbyId)).filter((p) => p.alive);
    return stillAlive.length <= 1 ? "decided" : "resolved";
  }

  private async settleRound(
    lobby: LobbyRow,
    round: RoundRow,
    question: Question,
    correct: string,
    minute: number
  ): Promise<void> {
    const roster = await this.playersOf(lobby.id);
    const alive = roster.filter((p) => p.alive).map((p) => p.id);
    const roundAnswers = await db.query.answers.findMany({ where: eq(answers.roundId, round.id) });
    const answerMap = new Map(roundAnswers.map((a) => [a.playerId, a.option]));

    const res = resolveElimination({
      alive,
      answers: answerMap,
      correct,
      graceForSilent: round.n === 1 && GRACE_ROUND_1,
    });

    // Anchor the round: merkle root over signed picks, before announcing.
    const leaves = roundAnswers
      .sort((a, b) => a.playerId.localeCompare(b.playerId))
      .map((a) => leafHash(a.commitHash, a.sig));
    const root = merkleRoot(leaves);
    let memoSig: string | null = null;
    if (this.memo) {
      try {
        memoSig = await this.memo(
          roundMemoPayload({
            lobbyId: lobby.id,
            roundN: round.n,
            merkleRoot: root,
            correct,
            picks: roundAnswers.length,
          })
        );
      } catch (e) {
        console.error(`[engine] round ${round.id} memo failed:`, (e as Error).message?.slice(0, 160));
      }
    }
    await db
      .update(rounds)
      .set({
        state: res.voided ? "voided" : "resolved",
        correctOption: correct,
        merkleRoot: root,
        memoSig,
        resolvedAt: Date.now(),
      })
      .where(eq(rounds.id, round.id));

    const correctLabel = question.options.find((o) => o.key === correct)?.label ?? correct;

    if (res.voided) {
      await this.say(
        lobby,
        round.n,
        "voided",
        `Answer: ${correctLabel}. And that would have wiped out every last one of you — ` +
          `so the round is annulled. A survivor pool needs survivors. Nobody dies. This time.`
      );
      return;
    }

    // Jinx bookkeeping happens before announcements so funerals can credit.
    const priorJinxes = await db.query.jinxes.findMany({ where: eq(jinxes.lobbyId, lobby.id) });
    const asJinx: Jinx[] = priorJinxes.map((jx) => ({
      jinxerId: jx.jinxerId,
      targetId: jx.targetId,
      roundN: jx.roundN,
    }));
    const landed = creditJinxes(asJinx, round.n, res.eliminated);
    for (const jx of landed) {
      await db
        .update(jinxes)
        .set({ credited: true })
        .where(and(eq(jinxes.lobbyId, lobby.id), eq(jinxes.jinxerId, jx.jinxerId)));
    }
    const jinxedBy = new Map<string, string>();
    for (const jx of landed) {
      const jinxer = roster.find((p) => p.id === jx.jinxerId);
      if (jinxer) jinxedBy.set(jx.targetId, jinxer.name);
    }

    await this.say(
      lobby,
      round.n,
      "verdict",
      `Answer: ${correctLabel}.` +
        (res.eliminated.length === 0
          ? ` Everyone lives. Boring, but the chart notes your cowardice-free round.`
          : ` ${res.eliminated.length} ${res.eliminated.length === 1 ? "fan falls" : "fans fall"}.`)
    );

    // Funerals — the product moment.
    const byId = new Map(roster.map((p) => [p.id, p]));
    const sortedElims = [...res.eliminated].sort((a, b) => {
      if (a.reason !== b.reason) return a.reason === "wrong" ? -1 : 1;
      const at = roundAnswers.find((x) => x.playerId === a.playerId)?.answeredAt ?? 0;
      const bt = roundAnswers.find((x) => x.playerId === b.playerId)?.answeredAt ?? 0;
      return at - bt;
    });
    for (const e of sortedElims) {
      const p = byId.get(e.playerId);
      if (!p) continue;
      const pickLabel =
        e.pick !== undefined ? question.options.find((o) => o.key === e.pick)?.label : undefined;
      await db
        .update(players)
        .set({
          alive: false,
          diedRound: round.n,
          fatalPick: pickLabel ?? null,
          diedMinute: minute,
        })
        .where(eq(players.id, p.id));
      if (!lobby.firstOutPlayerId) {
        await db.update(lobbies).set({ firstOutPlayerId: p.id }).where(eq(lobbies.id, lobby.id));
        lobby = { ...lobby, firstOutPlayerId: p.id };
      }
      try {
        const card = renderTombstoneCard({
          lobbyId: lobby.id,
          roundN: round.n,
          name: p.name,
          fatalPick: pickLabel,
          minute,
          jinxedBy: jinxedBy.get(p.id),
        });
        await this.sendPhoto(lobby, round.n, card, undefined);
      } catch (err) {
        console.error("[engine] tombstone render failed:", (err as Error).message?.slice(0, 160));
      }
      const line = funeralLine({
        lobbyId: lobby.id,
        roundN: round.n,
        name: p.name,
        reason: e.reason,
        pickLabel,
        minute,
      });
      await this.say(lobby, round.n, "funeral", await this.pundit.polish(line, `elimination round ${round.n}`));
      if (jinxedBy.has(p.id)) {
        await this.say(lobby, round.n, "jinx", jinxCreditLine(lobby.id, jinxedBy.get(p.id)!, p.name));
      }
    }

    await this.postWallChart(lobby.id);
  }

  // -- jinx + haunt ---------------------------------------------------------

  async castJinx(
    lobbyId: string,
    jinxerTgId: number,
    targetQuery: string
  ): Promise<{ ok: boolean; message: string }> {
    const lobby = await db.query.lobbies.findFirst({ where: eq(lobbies.id, lobbyId) });
    if (!lobby) return { ok: false, message: "No pool here." };
    const roster = await this.playersOf(lobbyId);
    const jinxer = roster.find((p) => p.tgId === jinxerTgId);
    if (!jinxer) return { ok: false, message: "You're not in this pool." };
    const q = targetQuery.replace(/^@/, "").trim().toLowerCase();
    const target = roster.find((p) => p.name.toLowerCase().startsWith(q) && p.id !== jinxer.id);
    if (!target) return { ok: false, message: `Can't find "${targetQuery}" in the pool.` };

    const prior = await db.query.jinxes.findMany({ where: eq(jinxes.lobbyId, lobbyId) });
    const check = canJinx({
      jinxerId: jinxer.id,
      targetId: target.id,
      alive: roster.filter((p) => p.alive).map((p) => p.id),
      allPlayers: roster.map((p) => p.id),
      priorJinxes: prior.map((jx) => ({ jinxerId: jx.jinxerId, targetId: jx.targetId, roundN: jx.roundN })),
    });
    if (!check.ok) {
      const why: Record<string, string> = {
        "jinxer-dead": "Ghosts can't jinx. You had your chance among the living.",
        "target-dead": `${target.name} is already under a tombstone. Have some respect.`,
        "already-used": "One kiricocho per match. Yours is spent.",
        "self-jinx": "You can't jinx yourself. The football does that for free.",
        "target-unknown": "They're not in this pool.",
      };
      return { ok: false, message: why[check.reason] };
    }
    // The curse applies to the next round that resolves: the current round if
    // it's still in flight, otherwise the one about to open.
    const lobbyRow = (await db.query.lobbies.findFirst({ where: eq(lobbies.id, lobbyId) }))!;
    const current = await db.query.rounds.findFirst({
      where: eq(rounds.id, `${lobbyId}:${lobbyRow.roundNo}`),
    });
    const applies =
      current && (current.state === "open" || current.state === "closed")
        ? lobbyRow.roundNo
        : lobbyRow.roundNo + 1;
    await db.insert(jinxes).values({
      lobbyId,
      jinxerId: jinxer.id,
      targetId: target.id,
      roundN: applies,
    });
    await this.say(lobbyRow, lobbyRow.roundNo, "jinx", jinxCastLine(jinxer.name, target.name));
    return { ok: true, message: "Curse deployed." };
  }

  async haunt(lobbyId: string, tgId: number): Promise<string> {
    const player = await db.query.players.findFirst({
      where: eq(players.id, `${lobbyId}:${tgId}`),
    });
    if (!player) return "You're not in this pool.";
    if (player.alive) return "You're still alive. Haunting is a privilege of the dead.";
    if (player.hauntUsed) return "One haunt per ghost. The veil is closed to you now.";
    await db.update(players).set({ hauntUsed: true }).where(eq(players.id, player.id));
    const lobby = (await db.query.lobbies.findFirst({ where: eq(lobbies.id, lobbyId) }))!;
    await this.say(lobby, null, "haunt", hauntLine(lobbyId, player.name));
    return "Haunt delivered.";
  }

  // -- endgame --------------------------------------------------------------

  async finish(lobbyId: string): Promise<void> {
    const lobby = (await db.query.lobbies.findFirst({ where: eq(lobbies.id, lobbyId) }))!;
    if (lobby.state === "finished") return;
    const roster = await this.playersOf(lobbyId);
    const alive = roster.filter((p) => p.alive);
    const { winners, sole } = crown(alive.map((p) => p.id));
    await db
      .update(lobbies)
      .set({ state: "finished", winnerPlayerId: winners[0] ?? null })
      .where(eq(lobbies.id, lobbyId));

    for (const winnerId of winners) {
      const w = roster.find((p) => p.id === winnerId)!;
      const survived = await this.roundsSurvived(lobbyId, winnerId);
      await this.say(lobby, null, "crown", coronationLine(w.name, survived, sole));
      await this.issueCert(lobby, w);
    }
    if (winners.length === 0) {
      await this.say(
        lobby,
        null,
        "crown",
        `Nobody survived. The pool ends the way most group-chat confidence does: a wall of tombstones. The chart is the only winner.`
      );
    }
    await this.postWallChart(lobbyId, true);
    await this.startForfeitVote(lobbyId);
  }

  private async roundsSurvived(lobbyId: string, playerId: string): Promise<number> {
    const all = await db.query.rounds.findMany({ where: eq(rounds.lobbyId, lobbyId) });
    return all.filter((r) => r.state === "resolved").length;
  }

  async issueCert(lobby: LobbyRow, winner: PlayerRow): Promise<SurvivorCert | undefined> {
    const allRounds = (await db.query.rounds.findMany({ where: eq(rounds.lobbyId, lobby.id) })).sort(
      (a, b) => a.n - b.n
    );
    const certRounds: CertRound[] = [];
    for (const r of allRounds) {
      if (r.state !== "resolved" || !r.correctOption) continue;
      const a = await db.query.answers.findFirst({
        where: and(eq(answers.roundId, r.id), eq(answers.playerId, winner.id)),
      });
      if (!a) continue; // survived on round-1 grace — nothing to attest
      const q = JSON.parse(r.questionJson) as Question;
      certRounds.push({
        n: r.n,
        trigger: r.trigger,
        question: q.text,
        pick: a.option,
        pickLabel: q.options.find((o) => o.key === a.option)?.label ?? a.option,
        salt: a.salt,
        commitHash: a.commitHash,
        sig: a.sig,
        correct: r.correctOption,
        merkleRoot: r.merkleRoot,
        memoSig: r.memoSig,
      });
    }
    const cert: SurvivorCert = {
      p: "last-fan-standing/cert/v1",
      lobbyId: lobby.id,
      fixtureId: lobby.fixtureId,
      fixture: `${lobby.home} v ${lobby.away}`,
      demo: lobby.demo,
      survivor: { name: winner.name, pubkey: winner.pubkey ?? "", playerId: winner.id },
      rounds: certRounds,
      anchorWallet: this.memo?.wallet ?? "",
      issuedAt: Date.now(),
    };
    const hash = certHash(cert);
    let memoSig: string | null = null;
    if (this.memo) {
      try {
        memoSig = await this.memo(certMemoPayload(cert));
      } catch (e) {
        console.error("[engine] cert memo failed:", (e as Error).message?.slice(0, 160));
      }
    }
    await db
      .insert(certs)
      .values({
        lobbyId: lobby.id,
        playerId: winner.id,
        certJson: JSON.stringify(cert),
        certHash: hash,
        memoSig,
        createdAt: Date.now(),
      })
      .onConflictDoNothing();

    const doc = new InputFile(
      Buffer.from(JSON.stringify(cert, null, 2), "utf8"),
      `survivor-cert-${lobby.id}-${winner.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}.json`
    );
    try {
      await this.bot.api.sendDocument(lobby.chatId, doc, {
        caption:
          `Survivor certificate — ${winner.name}\n` +
          `sha256: ${hash.slice(0, 16)}…\n` +
          (memoSig ? `Anchored in the Memo trail on Solana devnet.\n` : `(Memo anchor pending.)\n`) +
          (this.memo ? `Anchor account: ${accountLink(this.memo.wallet)}\n` : "") +
          `Verify it yourself, no wallet needed — paste this file into the verify page.`,
      });
    } catch (e) {
      console.error("[engine] cert document send failed:", (e as Error).message?.slice(0, 160));
    }
    return cert;
  }

  // -- forfeit contract -----------------------------------------------------

  async startForfeitVote(lobbyId: string): Promise<void> {
    const lobby = (await db.query.lobbies.findFirst({ where: eq(lobbies.id, lobbyId) }))!;
    if (!lobby.firstOutPlayerId) return;
    const loser = await db.query.players.findFirst({
      where: eq(players.id, lobby.firstOutPlayerId),
    });
    if (!loser) return;
    await db.update(lobbies).set({ forfeitState: "voting" }).where(eq(lobbies.id, lobbyId));
    const kb = new InlineKeyboard();
    for (const [key, label] of Object.entries(FORFEIT_TEMPLATES)) {
      kb.text(label.split(" — ")[0], `f:${lobbyId}:${key}`).row();
    }
    await this.say(
      lobby,
      null,
      "forfeit",
      `THE FORFEIT CONTRACT\n\n${loser.name} was first out of the pool. The group now votes their punishment:\n\n` +
        Object.values(FORFEIT_TEMPLATES)
          .map((t) => `· ${t}`)
          .join("\n") +
        `\n\nThe winning template is notarized in the Memo trail. ${loser.name} settles it with /proof (a photo to this chat). No money. No mercy.`,
      kb
    );
  }

  async voteForfeit(lobbyId: string, tgId: number, choice: string): Promise<"ok" | "closed" | "bad-choice"> {
    const lobby = await db.query.lobbies.findFirst({ where: eq(lobbies.id, lobbyId) });
    if (!lobby || lobby.forfeitState !== "voting") return "closed";
    if (!FORFEIT_TEMPLATES[choice]) return "bad-choice";
    await db
      .insert(forfeitVotes)
      .values({ lobbyId, voterId: String(tgId), choice })
      .onConflictDoUpdate({ target: [forfeitVotes.lobbyId, forfeitVotes.voterId], set: { choice } });
    return "ok";
  }

  async closeForfeitVote(lobbyId: string): Promise<void> {
    const lobby = (await db.query.lobbies.findFirst({ where: eq(lobbies.id, lobbyId) }))!;
    if (lobby.forfeitState !== "voting") return;
    const votes = await db.query.forfeitVotes.findMany({ where: eq(forfeitVotes.lobbyId, lobbyId) });
    const tallies = new Map<string, number>();
    for (const v of votes) tallies.set(v.choice, (tallies.get(v.choice) ?? 0) + 1);
    const order = Object.keys(FORFEIT_TEMPLATES);
    const winner =
      [...tallies.entries()].sort(
        (a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0])
      )[0]?.[0] ?? order[0];

    const loser = lobby.firstOutPlayerId
      ? await db.query.players.findFirst({ where: eq(players.id, lobby.firstOutPlayerId) })
      : undefined;
    let memoSig: string | null = null;
    if (this.memo && loser) {
      try {
        memoSig = await this.memo(
          forfeitMemoPayload({
            lobbyId,
            loserPubkey: loser.pubkey ?? "",
            template: winner,
            votes: votes.length,
          })
        );
      } catch (e) {
        console.error("[engine] forfeit memo failed:", (e as Error).message?.slice(0, 160));
      }
    }
    await db
      .update(lobbies)
      .set({ forfeitTemplate: winner, forfeitMemoSig: memoSig, forfeitState: "chosen" })
      .where(eq(lobbies.id, lobbyId));
    await this.say(
      lobby,
      null,
      "forfeit",
      `The group has spoken (${votes.length} vote${votes.length === 1 ? "" : "s"}).\n\n` +
        `${loser?.name ?? "The fallen"} owes: ${FORFEIT_TEMPLATES[winner]}.\n\n` +
        (memoSig
          ? `Notarized on devnet — this debt is now on a blockchain, which is objectively funnier than a spreadsheet. ` +
            `Settle with /proof.`
          : `Notarization pending. Settle with /proof.`)
    );
  }

  async submitProof(lobbyId: string, tgId: number): Promise<string> {
    const lobby = await db.query.lobbies.findFirst({ where: eq(lobbies.id, lobbyId) });
    if (!lobby || lobby.forfeitState !== "chosen") return "No open forfeit to settle here.";
    const loser = lobby.firstOutPlayerId
      ? await db.query.players.findFirst({ where: eq(players.id, lobby.firstOutPlayerId) })
      : undefined;
    if (!loser || loser.tgId !== tgId) return "Only the debtor settles the forfeit.";
    await db.update(lobbies).set({ forfeitState: "proofed" }).where(eq(lobbies.id, lobbyId));
    await this.say(
      lobby,
      null,
      "forfeit",
      `Proof received. ${loser.name}'s debt is settled and the ledger closes. Honour, technically, restored.`
    );
    return "Debt settled.";
  }

  // -- chart + plumbing -----------------------------------------------------

  async chartData(lobbyId: string): Promise<ChartData> {
    const lobby = (await db.query.lobbies.findFirst({ where: eq(lobbies.id, lobbyId) }))!;
    const roster = await this.playersOf(lobbyId);
    const allJinxes = await db.query.jinxes.findMany({ where: eq(jinxes.lobbyId, lobbyId) });
    const byId = new Map(roster.map((p) => [p.id, p]));
    return {
      fixture: `${lobby.home} v ${lobby.away}`,
      lobbyId: lobby.id,
      roundNo: lobby.roundNo,
      demo: lobby.demo,
      crowned: lobby.state === "finished",
      players: roster.map((p) => {
        const credited = allJinxes.filter((jx) => jx.credited && jx.jinxerId === p.id).length;
        const killer = allJinxes.find((jx) => jx.credited && jx.targetId === p.id);
        return {
          name: p.name,
          alive: p.alive,
          diedRound: p.diedRound ?? undefined,
          fatalPick: p.fatalPick ?? undefined,
          diedMinute: p.diedMinute ?? undefined,
          jinxCredits: credited,
          jinxedBy: killer ? byId.get(killer.jinxerId)?.name : undefined,
          isWinner: lobby.state === "finished" && p.alive,
        };
      }),
    };
  }

  async postWallChart(lobbyId: string, keepsake = false): Promise<void> {
    const lobby = (await db.query.lobbies.findFirst({ where: eq(lobbies.id, lobbyId) }))!;
    try {
      const png = renderWallChart(await this.chartData(lobbyId));
      await this.sendPhoto(
        lobby,
        lobby.roundNo,
        png,
        keepsake ? "The final wall chart. Frame it, forward it, never let them forget." : undefined
      );
    } catch (e) {
      console.error("[engine] wall chart render failed:", (e as Error).message?.slice(0, 160));
    }
  }

  async playersOf(lobbyId: string): Promise<PlayerRow[]> {
    const roster = await db.query.players.findMany({ where: eq(players.lobbyId, lobbyId) });
    return roster.sort((a, b) => a.joinedAt - b.joinedAt);
  }

  async say(
    lobby: LobbyRow,
    roundN: number | null,
    kind: string,
    body: string,
    kb?: InlineKeyboard
  ): Promise<void> {
    try {
      await this.bot.api.sendMessage(lobby.chatId, body, kb ? { reply_markup: kb } : undefined);
      await db.insert(messages).values({ lobbyId: lobby.id, roundN, kind, body, sentAt: Date.now() });
    } catch (e) {
      console.error(`[engine] say(${kind}) failed:`, (e as Error).message?.slice(0, 160));
    }
  }

  private async sendPhoto(
    lobby: LobbyRow,
    roundN: number | null,
    png: Buffer,
    caption?: string
  ): Promise<void> {
    try {
      await this.bot.api.sendPhoto(lobby.chatId, new InputFile(png, "chart.png"), { caption });
      await db.insert(messages).values({
        lobbyId: lobby.id,
        roundN,
        kind: "photo",
        body: caption ?? "(image)",
        sentAt: Date.now(),
      });
    } catch (e) {
      console.error("[engine] sendPhoto failed:", (e as Error).message?.slice(0, 160));
    }
  }
}
