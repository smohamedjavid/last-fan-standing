import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema.js";

/**
 * Lazily-initialized database handle. Initialization happens on first use —
 * never at import time — so configuration (DB_URL) is read after the entire
 * process (or test file) has had the chance to set it.
 */
let _client: Client | undefined;
let _db: LibSQLDatabase<typeof schema> | undefined;

export function getClient(): Client {
  if (!_client) {
    _client = createClient({ url: process.env.DB_URL ?? "file:lfs.db" });
  }
  return _client;
}

export function getDb(): LibSQLDatabase<typeof schema> {
  if (!_db) {
    _db = drizzle(getClient(), { schema });
  }
  return _db;
}

/** Ergonomic alias: `db.query…` etc., resolved lazily per property access. */
export const db: LibSQLDatabase<typeof schema> = new Proxy(
  {} as LibSQLDatabase<typeof schema>,
  {
    get(_t, prop, receiver) {
      const real = getDb() as unknown as Record<PropertyKey, unknown>;
      const value = Reflect.get(real, prop, receiver);
      return typeof value === "function" ? (value as CallableFunction).bind(real) : value;
    },
  }
);

/** Idempotent bootstrap — hackathon-grade migrations (single file, additive). */
export async function migrate(): Promise<void> {
  await getClient().executeMultiple(`
    CREATE TABLE IF NOT EXISTS lobbies (
      id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, fixture_id INTEGER NOT NULL,
      home TEXT NOT NULL, away TEXT NOT NULL, kickoff INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'open', demo INTEGER NOT NULL DEFAULT 0,
      round_no INTEGER NOT NULL DEFAULT 0,
      winner_player_id TEXT, first_out_player_id TEXT,
      forfeit_template TEXT, forfeit_memo_sig TEXT,
      forfeit_state TEXT NOT NULL DEFAULT 'none',
      reel_posted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY, lobby_id TEXT NOT NULL, tg_id INTEGER NOT NULL,
      name TEXT NOT NULL, pubkey TEXT, secret TEXT,
      alive INTEGER NOT NULL DEFAULT 1,
      died_round INTEGER, fatal_pick TEXT, died_minute INTEGER,
      jinx_used INTEGER NOT NULL DEFAULT 0, haunt_used INTEGER NOT NULL DEFAULT 0,
      scripted INTEGER NOT NULL DEFAULT 0,
      joined_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rounds (
      id TEXT PRIMARY KEY, lobby_id TEXT NOT NULL, n INTEGER NOT NULL,
      trigger TEXT NOT NULL, question_json TEXT NOT NULL,
      opens_at INTEGER NOT NULL, closes_at INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      correct_option TEXT, merkle_root TEXT, memo_sig TEXT, resolved_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS answers (
      round_id TEXT NOT NULL, player_id TEXT NOT NULL,
      option TEXT NOT NULL, salt TEXT NOT NULL,
      commit_hash TEXT NOT NULL, sig TEXT NOT NULL, answered_at INTEGER NOT NULL,
      PRIMARY KEY (round_id, player_id)
    );
    CREATE TABLE IF NOT EXISTS jinxes (
      lobby_id TEXT NOT NULL, jinxer_id TEXT NOT NULL, target_id TEXT NOT NULL,
      round_n INTEGER NOT NULL, credited INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (lobby_id, jinxer_id)
    );
    CREATE TABLE IF NOT EXISTS certs (
      lobby_id TEXT NOT NULL, player_id TEXT NOT NULL,
      cert_json TEXT NOT NULL, cert_hash TEXT NOT NULL, memo_sig TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (lobby_id, player_id)
    );
    CREATE TABLE IF NOT EXISTS forfeit_votes (
      lobby_id TEXT NOT NULL, voter_id TEXT NOT NULL, choice TEXT NOT NULL,
      PRIMARY KEY (lobby_id, voter_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, lobby_id TEXT NOT NULL,
      round_n INTEGER, kind TEXT NOT NULL, body TEXT NOT NULL,
      sent_at INTEGER NOT NULL
    );
  `);
  // Additive migrations for databases created before these columns existed.
  await addColumnIfMissing("players", "scripted", "INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing("lobbies", "forfeit_memo_sig", "TEXT");
  await addColumnIfMissing("lobbies", "reel_posted", "INTEGER NOT NULL DEFAULT 0");
}

async function addColumnIfMissing(table: string, column: string, type: string): Promise<void> {
  const info = await getClient().execute(`PRAGMA table_info(${table})`);
  const exists = info.rows.some((r) => r.name === column);
  if (!exists) {
    await getClient().execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
