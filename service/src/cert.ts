import { sha256Hex } from "./merkle.js";

/**
 * The survivor certificate: the full path of correct signed picks that kept
 * one player alive from kickoff to the crown. Its hash goes on-chain in a
 * Memo; the JSON goes to the group as a document. Anyone can recompute
 * every hash in a browser with zero wallets and zero trust in us.
 */

export interface CertRound {
  n: number;
  trigger: string;
  question: string;
  pick: string;
  pickLabel: string;
  salt: string;
  commitHash: string;
  sig: string;
  correct: string;
  merkleRoot: string | null;
  memoSig: string | null;
}

export interface SurvivorCert {
  p: "last-fan-standing/cert/v1";
  lobbyId: string;
  fixtureId: number;
  fixture: string;
  demo: boolean;
  survivor: { name: string; pubkey: string; playerId: string };
  rounds: CertRound[];
  /** wallet whose Memo trail anchors this lobby */
  anchorWallet: string;
  issuedAt: number;
}

/**
 * The cert hash binds survivor identity + every round's commitment + every
 * round's outcome. Stable: field order is fixed here, never JSON-dependent.
 */
export function certHash(cert: SurvivorCert): string {
  const material = [
    cert.p,
    cert.lobbyId,
    String(cert.fixtureId),
    cert.survivor.playerId,
    cert.survivor.pubkey,
    ...cert.rounds.map((r) => [r.n, r.pick, r.salt, r.commitHash, r.sig, r.correct].join("|")),
  ].join("\n");
  return sha256Hex(material);
}

export function certMemoPayload(cert: SurvivorCert): string {
  return JSON.stringify({
    p: "lfs/cert/v1",
    l: cert.lobbyId,
    f: cert.fixtureId,
    k: cert.survivor.pubkey,
    h: certHash(cert),
    n: cert.rounds.length,
  });
}
