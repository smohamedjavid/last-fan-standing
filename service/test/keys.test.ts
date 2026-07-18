import { describe, it, expect } from "vitest";
import { mintKeypair, pickCommitHash, signHash, verifySig, newSalt } from "../src/keys.js";
import { leafHash, merkleRoot, sha256Hex } from "../src/merkle.js";

describe("signature roundtrip", () => {
  it("a player's own key signs and verifies their pick hash", () => {
    const kp = mintKeypair();
    const hash = pickCommitHash({
      lobbyId: "abc123",
      roundN: 2,
      playerId: "abc123:42",
      option: "home",
      salt: newSalt(),
    });
    const sig = signHash(hash, kp.secret);
    expect(verifySig(hash, sig, kp.pubkey)).toBe(true);
  });

  it("verification fails for the wrong key or tampered hash", () => {
    const kp = mintKeypair();
    const other = mintKeypair();
    const hash = pickCommitHash({
      lobbyId: "abc123",
      roundN: 2,
      playerId: "abc123:42",
      option: "home",
      salt: "aabbccdd11223344",
    });
    const sig = signHash(hash, kp.secret);
    expect(verifySig(hash, sig, other.pubkey)).toBe(false);
    const tampered = pickCommitHash({
      lobbyId: "abc123",
      roundN: 2,
      playerId: "abc123:42",
      option: "away", // pick changed after signing
      salt: "aabbccdd11223344",
    });
    expect(verifySig(tampered, sig, kp.pubkey)).toBe(false);
  });

  it("commit hash is deterministic and salt-sensitive", () => {
    const base = { lobbyId: "l", roundN: 1, playerId: "l:1", option: "home" };
    expect(pickCommitHash({ ...base, salt: "s1" })).toBe(pickCommitHash({ ...base, salt: "s1" }));
    expect(pickCommitHash({ ...base, salt: "s1" })).not.toBe(pickCommitHash({ ...base, salt: "s2" }));
  });
});

describe("merkle root", () => {
  it("is order-stable and content-sensitive", () => {
    const a = leafHash(sha256Hex("h1"), "sig1");
    const b = leafHash(sha256Hex("h2"), "sig2");
    const c = leafHash(sha256Hex("h3"), "sig3");
    expect(merkleRoot([a, b, c])).toBe(merkleRoot([a, b, c]));
    expect(merkleRoot([a, b, c])).not.toBe(merkleRoot([b, a, c]));
    expect(merkleRoot([a, b])).not.toBe(merkleRoot([a, c]));
  });

  it("handles empty and single-leaf rounds", () => {
    expect(merkleRoot([])).toBe(sha256Hex("empty"));
    const a = leafHash("h", "s");
    expect(merkleRoot([a])).toBe(a);
  });
});
