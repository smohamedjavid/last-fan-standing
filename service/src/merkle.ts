import { createHash } from "node:crypto";

/**
 * Minimal binary merkle over the round's signed picks. The leaf is
 * sha256(commitHash|sig) so the tree binds both the pick commitment and the
 * player's own ed25519 signature. Odd nodes are promoted (no duplication).
 * One root per round goes in the Memo — the whole round is one anchor.
 */

export function sha256Hex(material: string): string {
  return createHash("sha256").update(material).digest("hex");
}

export function leafHash(commitHash: string, sig: string): string {
  return sha256Hex(`${commitHash}|${sig}`);
}

export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return sha256Hex("empty");
  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? sha256Hex(`${level[i]}|${level[i + 1]}`) : level[i]);
    }
    level = next;
  }
  return level[0];
}
