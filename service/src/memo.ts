import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import fs from "node:fs";

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export interface MemoSender {
  (memoJson: string): Promise<string>; // returns tx signature
  wallet: string; // the anchor wallet pubkey (for account links + verify page)
}

/**
 * Devnet Memo anchor. One service keypair notarizes round roots, survivor
 * certificates and forfeit contracts. Devnet's RPC keeps ~4 days of tx
 * history, so everything we publish links to the ACCOUNT (the wallet's
 * explorer page), never a /tx/ URL — and evidence JSONs get archived in-repo.
 */
export function keypairMemoSender(opts?: { rpc?: string; keypairPath?: string }): MemoSender {
  const rpc = opts?.rpc ?? process.env.RPC ?? "https://solana-devnet.api.onfinality.io/public";
  const path =
    opts?.keypairPath ??
    process.env.MEMO_KEYPAIR ??
    new URL("../../../txline-kit/.spike-keypair.json", import.meta.url).pathname;
  const keypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path, "utf8"))));
  const conn = new Connection(rpc, "confirmed");

  const send = async (memoJson: string): Promise<string> => {
    const ix = new TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memoJson, "utf8"),
    });
    return sendAndConfirmTransaction(conn, new Transaction().add(ix), [keypair]);
  };
  send.wallet = keypair.publicKey.toBase58();
  return send;
}

/** Round anchor: {roundId, merkle root of signed picks, question, outcome}. */
export function roundMemoPayload(opts: {
  lobbyId: string;
  roundN: number;
  merkleRoot: string;
  correct: string;
  picks: number;
}): string {
  return JSON.stringify({
    p: "lfs/round/v1",
    l: opts.lobbyId,
    n: opts.roundN,
    r: opts.merkleRoot,
    c: opts.correct,
    k: opts.picks,
  });
}

/** Forfeit contract: the group's chosen punishment, notarized. */
export function forfeitMemoPayload(opts: {
  lobbyId: string;
  loserPubkey: string;
  template: string;
  votes: number;
}): string {
  return JSON.stringify({
    p: "lfs/forfeit/v1",
    l: opts.lobbyId,
    k: opts.loserPubkey,
    t: opts.template,
    v: opts.votes,
  });
}

export function accountLink(wallet: string): string {
  return `https://explorer.solana.com/address/${wallet}?cluster=devnet`;
}
