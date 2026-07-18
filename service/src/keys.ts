import { randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { sha256Hex } from "./merkle.js";

/**
 * Every player gets a Solana keypair at join — joining IS the signup.
 * Custodial today (players are non-crypto group-chat humans; keys are
 * zero-value devnet identities); the roadmap swap is client-side keys in a
 * Mini App. The keypair's only job: sign pick commitments so a player's
 * answers can't be forged, backdated, or "remembered differently".
 */

export function mintKeypair(): { pubkey: string; secret: string } {
  const kp = Keypair.generate();
  return { pubkey: kp.publicKey.toBase58(), secret: bs58.encode(kp.secretKey) };
}

/** sha256(lobbyId|roundN|playerId|option|salt) — the committed pick. */
export function pickCommitHash(p: {
  lobbyId: string;
  roundN: number;
  playerId: string;
  option: string;
  salt: string;
}): string {
  return sha256Hex([p.lobbyId, String(p.roundN), p.playerId, p.option, p.salt].join("|"));
}

export function newSalt(): string {
  return randomBytes(8).toString("hex");
}

/** The player's own key signs their pick hash — identity travels with it. */
export function signHash(commitHashHex: string, secretB58: string): string {
  const sig = nacl.sign.detached(Buffer.from(commitHashHex, "hex"), bs58.decode(secretB58));
  return bs58.encode(sig);
}

export function verifySig(commitHashHex: string, sigB58: string, pubkeyB58: string): boolean {
  try {
    return nacl.sign.detached.verify(
      Buffer.from(commitHashHex, "hex"),
      bs58.decode(sigB58),
      bs58.decode(pubkeyB58)
    );
  } catch (e) {
    console.error("[keys] signature verify threw:", (e as Error).message);
    return false;
  }
}
