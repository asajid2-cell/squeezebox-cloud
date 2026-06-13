import { describe, it, expect } from "vitest";
import { aesCmac, verifySun } from "../server/tapSun.js";

const KEY = Buffer.from("2b7e151628aed2a6abf7158809cf4f3c", "hex");
const hex = (b: Buffer) => b.toString("hex");

// Proving the CMAC implementation against the canonical RFC 4493 test vectors —
// crypto must match the spec, not just "look right".
describe("AES-CMAC (RFC 4493 vectors)", () => {
  it("empty message", () => {
    expect(hex(aesCmac(KEY, Buffer.alloc(0)))).toBe("bb1d6929e95937287fa37d129b756746");
  });
  it("16-byte message (complete block → K1 path)", () => {
    expect(hex(aesCmac(KEY, Buffer.from("6bc1bee22e409f96e93d7e117393172a", "hex")))).toBe("070a16b46b4d4144f79bdd9dd04a287c");
  });
  it("40-byte message (partial block → K2 padding path)", () => {
    const m = Buffer.from("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411", "hex");
    expect(hex(aesCmac(KEY, m))).toBe("dfa66747de9ae63030ca32611497c827");
  });
});

describe("SUN verification", () => {
  const keyHex = "00112233445566778899aabbccddeeff";
  const tagId = "abc123";
  const cmacFor = (ctr: number) => aesCmac(Buffer.from(keyHex, "hex"), Buffer.from(`${tagId}|${ctr}`, "utf8")).toString("hex");

  it("accepts a valid SUN message", () => {
    expect(verifySun({ keyHex, tagId, ctr: 5, cmacHex: cmacFor(5) })).toBe(true);
  });
  it("rejects a CMAC for a different counter or garbage", () => {
    expect(verifySun({ keyHex, tagId, ctr: 5, cmacHex: cmacFor(6) })).toBe(false);
    expect(verifySun({ keyHex, tagId, ctr: 5, cmacHex: "deadbeefdeadbeefdeadbeefdeadbeef" })).toBe(false);
  });
  it("rejects a wrong-length key, empty cmac, or non-integer counter", () => {
    expect(verifySun({ keyHex: "1234", tagId, ctr: 5, cmacHex: cmacFor(5) })).toBe(false);
    expect(verifySun({ keyHex, tagId, ctr: 5, cmacHex: "" })).toBe(false);
    expect(verifySun({ keyHex, tagId, ctr: 1.5, cmacHex: cmacFor(1.5) })).toBe(false);
  });
});
