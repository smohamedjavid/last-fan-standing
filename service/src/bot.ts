import { Bot } from "grammy";
import { desc, eq } from "drizzle-orm";
import { db } from "./db.js";
import { lobbies, certs, players } from "./schema.js";
import type { Engine } from "./engine.js";
import { runDemo, demoRunningIn } from "./demo.js";
import { accountLink } from "./memo.js";

export interface FixtureInfo {
  fixtureId: number;
  home: string;
  away: string;
  startTime: number;
}

/**
 * Group-chat-first UX. The bot alone is the complete product: lobby, rounds,
 * jinxes, funerals, forfeits — all inline keyboards and slash commands.
 */
export function buildBot(
  token: string,
  wire: (bot: Bot) => Engine,
  getNextFixture?: () => Promise<FixtureInfo | undefined>
): Bot {
  const bot = new Bot(token);
  const engine = wire(bot);

  bot.command("start", (ctx) =>
    ctx.reply(
      `LAST FAN STANDING — the survivor pool your group chat already runs, ` +
        `compressed into 90 minutes of sudden-death picks on live match events. ` +
        `Impossible to welch: every pick is signed by your own key and anchored on Solana before the outcome exists.\n\n` +
        `/royale — open a pool on the next real fixture (run it in a group)\n` +
        `/demo — the full 3-minute scripted matchday, works anywhere, now\n` +
        `/jinx <name> — your one KIRICOCHO curse per match\n` +
        `/haunt — one message from beyond, ghosts only\n` +
        `/chart — the current wall chart\n` +
        `/receipt — re-send the survivor certificate\n` +
        `/proof — settle your forfeit (photo with caption /proof)\n\n` +
        `No money ever moves. Glory and forfeits only.`
    )
  );

  bot.command("demo", async (ctx) => {
    if (await demoRunningIn(ctx.chat.id)) {
      return ctx.reply("A pool is already running in this chat. Let it finish first.");
    }
    void runDemo(engine, ctx.chat.id, ctx.from!.id, ctx.from!.first_name).catch((e) => {
      console.error("[bot] demo crashed:", e);
      void ctx.reply("The demo fell over — that's on us. Try /demo again.");
    });
  });

  bot.command("royale", async (ctx) => {
    if (await demoRunningIn(ctx.chat.id)) {
      return ctx.reply("A pool is already open in this chat.");
    }
    const fx = getNextFixture ? await getNextFixture() : undefined;
    if (!fx) {
      return ctx.reply(
        "No live fixture on the feed right now. /demo runs the full scripted matchday instead."
      );
    }
    if (fx.startTime <= Date.now()) {
      return ctx.reply("Next fixture already kicked off — too late to open a fair pool.");
    }
    await engine.openLobby({
      chatId: ctx.chat.id,
      fixtureId: fx.fixtureId,
      home: fx.home,
      away: fx.away,
      kickoff: fx.startTime,
    });
  });

  bot.callbackQuery(/^j:(.+)$/, async (ctx) => {
    const [, lobbyId] = ctx.match!;
    const r = await engine.join(lobbyId, ctx.from.id, ctx.from.first_name);
    if (r.status === "joined") {
      await ctx.answerCallbackQuery({ text: "You're in. Key minted." });
      return ctx.reply(
        `${ctx.from.first_name} is in the pool. Their picks sign as ${r.pubkey?.slice(0, 8)}… — ` +
          `sealed on-chain before any outcome exists.`
      );
    }
    if (r.status === "already") return ctx.answerCallbackQuery({ text: "Already in." });
    if (r.status === "locked")
      return ctx.answerCallbackQuery({ text: "Locked. Watch from the stands." });
    return ctx.answerCallbackQuery({ text: "That pool no longer exists." });
  });

  bot.callbackQuery(/^a:([^:]+):(\d+):(.+)$/, async (ctx) => {
    const [, lobbyId, nRaw, option] = ctx.match!;
    const r = await engine.answer(lobbyId, Number(nRaw), ctx.from.id, option);
    const feedback: Record<typeof r, string> = {
      ok: "Locked in. Signed with your key.",
      updated: "Changed your mind — new pick signed.",
      late: "Window's shut. The football doesn't wait.",
      dead: "You're dead. Ghosts don't get a vote — they get /haunt.",
      "not-playing": "You never joined this pool.",
      "no-round": "That round is gone.",
    };
    return ctx.answerCallbackQuery({ text: feedback[r] });
  });

  bot.callbackQuery(/^f:([^:]+):(.+)$/, async (ctx) => {
    const [, lobbyId, choice] = ctx.match!;
    const r = await engine.voteForfeit(lobbyId, ctx.from.id, choice);
    return ctx.answerCallbackQuery({
      text: r === "ok" ? "Vote counted. Justice, group-chat style." : "Voting is closed.",
    });
  });

  bot.command("jinx", async (ctx) => {
    const lobby = await activeLobby(ctx.chat.id);
    if (!lobby) return ctx.reply("No pool running here.");
    const target = (ctx.match ?? "").toString().trim();
    if (!target) return ctx.reply("Usage: /jinx <name> — one curse per match, spend it wisely.");
    const r = await engine.castJinx(lobby.id, ctx.from!.id, target);
    if (!r.ok) return ctx.reply(r.message);
  });

  bot.command("haunt", async (ctx) => {
    const lobby = await latestLobby(ctx.chat.id);
    if (!lobby) return ctx.reply("No pool has ever run here. Nothing to haunt.");
    const msg = await engine.haunt(lobby.id, ctx.from!.id);
    if (msg !== "Haunt delivered.") return ctx.reply(msg);
  });

  bot.command("chart", async (ctx) => {
    const lobby = await latestLobby(ctx.chat.id);
    if (!lobby) return ctx.reply("No pool here yet — /royale or /demo.");
    await engine.postWallChart(lobby.id, lobby.state === "finished");
  });

  bot.command("receipt", async (ctx) => {
    const lobby = await latestLobby(ctx.chat.id);
    if (!lobby) return ctx.reply("No pool here yet.");
    const rows = await db.query.certs.findMany({ where: eq(certs.lobbyId, lobby.id) });
    if (rows.length === 0) return ctx.reply("No certificate yet — the pool hasn't crowned anyone.");
    for (const c of rows) {
      const winner = await db.query.players.findFirst({ where: eq(players.id, c.playerId) });
      const lobbyRow = (await db.query.lobbies.findFirst({ where: eq(lobbies.id, c.lobbyId) }))!;
      if (winner) await engine.issueCert(lobbyRow, winner);
    }
    if (engine.memo) {
      return ctx.reply(`Every anchor for this pool lives at:\n${accountLink(engine.memo.wallet)}`);
    }
  });

  bot.command("proof", (ctx) =>
    ctx.reply("Send the photo with the caption /proof — the ledger needs to see it.")
  );

  bot.on("message:photo", async (ctx) => {
    const caption = ctx.message.caption ?? "";
    if (!caption.trim().toLowerCase().startsWith("/proof")) return;
    const lobby = await latestLobby(ctx.chat.id);
    if (!lobby) return;
    const msg = await engine.submitProof(lobby.id, ctx.from.id);
    if (msg !== "Debt settled.") return ctx.reply(msg);
  });

  return bot;
}

async function activeLobby(chatId: number) {
  const rows = await db.query.lobbies.findMany({
    where: eq(lobbies.chatId, chatId),
    orderBy: [desc(lobbies.createdAt)],
  });
  return rows.find((l) => l.state !== "finished");
}

async function latestLobby(chatId: number) {
  const rows = await db.query.lobbies.findMany({
    where: eq(lobbies.chatId, chatId),
    orderBy: [desc(lobbies.createdAt)],
  });
  return rows[0];
}
