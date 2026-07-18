import fs from "node:fs";
import { migrate } from "./db.js";
import { buildBot } from "./bot.js";
import { Engine } from "./engine.js";
import { Ingest } from "./ingest.js";
import { keypairMemoSender, type MemoSender } from "./memo.js";
import { buildApi } from "./api.js";

/**
 * Dev convenience: pick up local secrets when env vars aren't set.
 * Production sets real env vars; nothing here is required.
 */
function loadLocalSecrets(): void {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    const p = new URL("../../../.secrets/telegram.env", import.meta.url).pathname;
    if (fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^([A-Z_]+)=(.+)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
      }
      console.log("[main] telegram credentials loaded from ../.secrets/telegram.env");
    }
  }
  if (!process.env.TXLINE_JWT) {
    const p = new URL("../../../txline-kit/.spike-tokens.json", import.meta.url).pathname;
    if (fs.existsSync(p)) {
      const t = JSON.parse(fs.readFileSync(p, "utf8"));
      process.env.TXLINE_JWT = t.jwt;
      process.env.TXLINE_API_TOKEN = t.apiToken;
      console.log("[main] txline tokens loaded from txline-kit/.spike-tokens.json");
    }
  }
}

async function main() {
  loadLocalSecrets();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");

  await migrate();

  let memo: MemoSender | null = null;
  try {
    memo = keypairMemoSender();
    console.log(`[main] memo anchor wallet: ${memo.wallet}`);
  } catch (e) {
    console.error("[main] no memo keypair — anchoring disabled:", (e as Error).message);
  }

  let ingest: Ingest | undefined;
  const bot = buildBot(
    token,
    (b) => {
      const engine = new Engine(b, memo);
      if (process.env.TXLINE_JWT && process.env.TXLINE_API_TOKEN) {
        ingest = new Ingest(engine);
      } else {
        console.warn("[main] no TxLINE tokens — live matches disabled, /demo fully functional");
      }
      return engine;
    },
    () => (ingest ? ingest.nextFixture() : Promise.resolve(undefined))
  );

  if (ingest) await ingest.start();

  const api = buildApi(memo?.wallet);
  const port = Number(process.env.API_PORT ?? 8791);
  await api.listen({ port, host: "0.0.0.0" });
  console.log(`[api] listening on :${port}`);

  await bot.start({
    onStart: (me) => console.log(`[bot] @${me.username} polling`),
  });
}

main().catch((e) => {
  console.error("[main] fatal:", e);
  process.exit(1);
});
