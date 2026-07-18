import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "./db.js";
import { lobbies, players, rounds, certs } from "./schema.js";
import { accountLink } from "./memo.js";

/**
 * Read API for the verify page. Everything here is pool-public; secrets
 * never leave the players table.
 */
export function buildApi(anchorWallet?: string): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("access-control-allow-origin", "*");
  });

  app.get<{ Params: { lobbyId: string } }>("/api/lobby/:lobbyId", async (req, reply) => {
    const lobby = await db.query.lobbies.findFirst({ where: eq(lobbies.id, req.params.lobbyId) });
    if (!lobby) return reply.code(404).send({ error: "no such pool" });
    const roster = await db.query.players.findMany({
      where: eq(players.lobbyId, lobby.id),
    });
    const allRounds = await db.query.rounds.findMany({ where: eq(rounds.lobbyId, lobby.id) });
    return {
      id: lobby.id,
      fixture: `${lobby.home} v ${lobby.away}`,
      state: lobby.state,
      demo: lobby.demo,
      players: roster.map((p) => ({
        name: p.name,
        pubkey: p.pubkey,
        alive: p.alive,
        diedRound: p.diedRound,
        fatalPick: p.fatalPick,
      })),
      rounds: allRounds
        .sort((a, b) => a.n - b.n)
        .map((r) => ({
          n: r.n,
          trigger: r.trigger,
          state: r.state,
          correct: r.correctOption,
          merkleRoot: r.merkleRoot,
          memoSig: r.memoSig,
        })),
    };
  });

  app.get<{ Params: { lobbyId: string } }>("/api/cert/:lobbyId", async (req, reply) => {
    const rows = await db.query.certs.findMany({ where: eq(certs.lobbyId, req.params.lobbyId) });
    if (rows.length === 0) return reply.code(404).send({ error: "no certificate yet" });
    return {
      certs: rows.map((c) => ({
        certHash: c.certHash,
        memoSig: c.memoSig,
        cert: JSON.parse(c.certJson),
      })),
    };
  });

  app.get("/api/anchor", async () => ({
    wallet: anchorWallet ?? null,
    link: anchorWallet ? accountLink(anchorWallet) : null,
  }));

  app.get("/health", async () => ({ ok: true }));
  return app;
}
