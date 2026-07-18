import { describe, it, expect } from "vitest";
import { certHash, certMemoPayload, type SurvivorCert } from "../src/cert.js";

function sampleCert(): SurvivorCert {
  return {
    p: "last-fan-standing/cert/v1",
    lobbyId: "deadbeef",
    fixtureId: 18257739,
    fixture: "Spain v Argentina",
    demo: false,
    survivor: { name: "Sarah", pubkey: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", playerId: "deadbeef:10" },
    rounds: [
      {
        n: 1,
        trigger: "kickoff",
        question: "First goal before 25' — who scores it?",
        pick: "home",
        pickLabel: "Spain",
        salt: "0011223344556677",
        commitHash: "aa".repeat(32),
        sig: "sig1",
        correct: "home",
        merkleRoot: "bb".repeat(32),
        memoSig: "memo1",
      },
    ],
    anchorWallet: "spike11111111111111111111111111111111111111",
    issuedAt: 1752900000000,
  };
}

describe("certificate hash stability", () => {
  it("same cert → same hash, every time", () => {
    expect(certHash(sampleCert())).toBe(certHash(sampleCert()));
  });

  it("hash ignores presentation fields but binds the pick path", () => {
    const a = sampleCert();
    const b = sampleCert();
    b.fixture = "Renamed Fixture"; // label change → same hash (not in material)
    b.issuedAt = 0;
    expect(certHash(a)).toBe(certHash(b));

    const c = sampleCert();
    c.rounds[0].pick = "away"; // pick change → different hash
    expect(certHash(a)).not.toBe(certHash(c));

    const d = sampleCert();
    d.survivor.pubkey = "changed"; // identity change → different hash
    expect(certHash(a)).not.toBe(certHash(d));
  });

  it("memo payload carries the hash and stays under memo size", () => {
    const cert = sampleCert();
    const payload = certMemoPayload(cert);
    expect(payload).toContain(certHash(cert));
    expect(Buffer.byteLength(payload, "utf8")).toBeLessThan(500);
    const parsed = JSON.parse(payload);
    expect(parsed.p).toBe("lfs/cert/v1");
    expect(parsed.n).toBe(1);
  });
});
