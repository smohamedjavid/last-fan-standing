import { describe, it, expect, beforeAll } from "vitest";

process.env.DB_URL = ":memory:";

import { migrate, getClient } from "../src/db.js";

describe("migrations", () => {
  beforeAll(async () => {
    await migrate();
  });

  it("are idempotent — running twice changes nothing and throws nothing", async () => {
    await migrate();
    await migrate();
    const tables = await getClient().execute(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    );
    const names = tables.rows.map((r) => r.name);
    for (const t of ["lobbies", "players", "rounds", "answers", "jinxes", "certs", "forfeit_votes", "messages"]) {
      expect(names).toContain(t);
    }
  });

  it("additive column migration adds missing columns exactly once", async () => {
    // simulate an old database missing a column
    await getClient().execute(`ALTER TABLE players DROP COLUMN scripted`);
    await migrate();
    const info = await getClient().execute(`PRAGMA table_info(players)`);
    const cols = info.rows.filter((r) => r.name === "scripted");
    expect(cols).toHaveLength(1);
    await migrate(); // and never a duplicate
    const info2 = await getClient().execute(`PRAGMA table_info(players)`);
    expect(info2.rows.filter((r) => r.name === "scripted")).toHaveLength(1);
  });
});
