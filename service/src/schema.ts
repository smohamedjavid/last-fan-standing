import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

/**
 * One royale per (group chat, fixture). A royale is a 90-minute sudden-death
 * survivor pool: rounds fire on live match events, wrong or silent answers
 * eliminate, last fan standing takes the certificate.
 */
export const lobbies = sqliteTable("lobbies", {
  id: text("id").primaryKey(), // short slug used in deep links + memo payloads
  chatId: integer("chat_id").notNull(),
  fixtureId: integer("fixture_id").notNull(),
  home: text("home").notNull(),
  away: text("away").notNull(),
  kickoff: integer("kickoff").notNull(),
  /** open (joinable) | locked (kickoff passed) | live | finished */
  state: text("state").notNull().default("open"),
  /** demo lobbies run the scripted replay matchday — never live data */
  demo: integer("demo", { mode: "boolean" }).notNull().default(false),
  roundNo: integer("round_no").notNull().default(0),
  winnerPlayerId: text("winner_player_id"),
  firstOutPlayerId: text("first_out_player_id"),
  forfeitTemplate: text("forfeit_template"),
  forfeitMemoSig: text("forfeit_memo_sig"),
  /** none | voting | chosen | proofed */
  forfeitState: text("forfeit_state").notNull().default("none"),
  createdAt: integer("created_at").notNull(),
});

export const players = sqliteTable("players", {
  id: text("id").primaryKey(), // `${lobbyId}:${tgId}`
  lobbyId: text("lobby_id").notNull(),
  tgId: integer("tg_id").notNull(),
  name: text("name").notNull(),
  /** Every player gets a Solana keypair at join; it signs their pick hashes. */
  pubkey: text("pubkey"),
  /** Custodial secret (devnet, zero-value) — roadmap: client-side keys. */
  secret: text("secret"),
  alive: integer("alive", { mode: "boolean" }).notNull().default(true),
  diedRound: integer("died_round"),
  fatalPick: text("fatal_pick"),
  diedMinute: integer("died_minute"),
  jinxUsed: integer("jinx_used", { mode: "boolean" }).notNull().default(false),
  hauntUsed: integer("haunt_used", { mode: "boolean" }).notNull().default(false),
  /** demo bots are scripted; real members answer via buttons */
  scripted: integer("scripted", { mode: "boolean" }).notNull().default(false),
  joinedAt: integer("joined_at").notNull(),
});

export const rounds = sqliteTable("rounds", {
  id: text("id").primaryKey(), // `${lobbyId}:${n}`
  lobbyId: text("lobby_id").notNull(),
  n: integer("n").notNull(),
  /** kickoff | goal | card | halftime | late | fulltime | shootout */
  trigger: text("trigger").notNull(),
  questionJson: text("question_json").notNull(),
  opensAt: integer("opens_at").notNull(),
  closesAt: integer("closes_at").notNull(),
  /** open | closed | resolved | voided */
  state: text("state").notNull().default("open"),
  correctOption: text("correct_option"),
  merkleRoot: text("merkle_root"),
  memoSig: text("memo_sig"),
  resolvedAt: integer("resolved_at"),
});

export const answers = sqliteTable(
  "answers",
  {
    roundId: text("round_id").notNull(),
    playerId: text("player_id").notNull(),
    option: text("option").notNull(),
    salt: text("salt").notNull(),
    /** sha256(lobbyId|roundN|playerId|option|salt) — the committed pick */
    commitHash: text("commit_hash").notNull(),
    /** ed25519 signature of commitHash by the player's own key */
    sig: text("sig").notNull(),
    answeredAt: integer("answered_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.roundId, t.playerId] })]
);

/** KIRICOCHO — one jinx per player per match. Drama only, never scoring. */
export const jinxes = sqliteTable(
  "jinxes",
  {
    lobbyId: text("lobby_id").notNull(),
    jinxerId: text("jinxer_id").notNull(),
    targetId: text("target_id").notNull(),
    roundN: integer("round_n").notNull(),
    credited: integer("credited", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.lobbyId, t.jinxerId] })]
);

export const certs = sqliteTable(
  "certs",
  {
    lobbyId: text("lobby_id").notNull(),
    playerId: text("player_id").notNull(),
    certJson: text("cert_json").notNull(),
    certHash: text("cert_hash").notNull(),
    memoSig: text("memo_sig"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.lobbyId, t.playerId] })]
);

/** Forfeit-contract votes: the group picks the first-out's punishment. */
export const forfeitVotes = sqliteTable(
  "forfeit_votes",
  {
    lobbyId: text("lobby_id").notNull(),
    voterId: text("voter_id").notNull(),
    choice: text("choice").notNull(),
  },
  (t) => [primaryKey({ columns: [t.lobbyId, t.voterId] })]
);

/** Everything the bot says — audit trail. */
export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  lobbyId: text("lobby_id").notNull(),
  roundN: integer("round_n"),
  kind: text("kind").notNull(),
  body: text("body").notNull(),
  sentAt: integer("sent_at").notNull(),
});
