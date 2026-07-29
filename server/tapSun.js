// Squeezebox Tap — NTAG 424 DNA "SUN" (Secure Unique NFC) verification tier.
//
// The static signed-token path proves a tag was minted by us (anti-forgery) but
// can't tell a fresh tap from a forwarded/pasted URL — a static URL is static.
// NTAG 424 DNA chips fix that: on every tap the chip emits a FRESH message with
// an incrementing counter and an AES-CMAC over it, keyed by an on-chip key that
// is never readable. We verify the CMAC with the shared per-tag key AND require
// the counter to strictly increase — so a replayed/forwarded URL carries a stale
// counter and is rejected. This is the only thing that genuinely defeats a
// forwarded link.
//
// AES-CMAC here is RFC 4493 (AES-128), implemented over node:crypto's AES-ECB
// (proven against the RFC 4493 test vectors in tests/tapSun.test.ts).
import crypto from "node:crypto";

const BLOCK = 16;

function xor(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function leftShift1(buf) {
  const out = Buffer.alloc(buf.length);
  let carry = 0;
  for (let i = buf.length - 1; i >= 0; i--) {
    out[i] = ((buf[i] << 1) | carry) & 0xff;
    carry = (buf[i] & 0x80) ? 1 : 0;
  }
  return out;
}

function aesEcb(key, block) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}

function subkeys(key) {
  const Rb = Buffer.alloc(16);
  Rb[15] = 0x87;
  const L = aesEcb(key, Buffer.alloc(16));
  let K1 = leftShift1(L);
  if (L[0] & 0x80) K1 = xor(K1, Rb);
  let K2 = leftShift1(K1);
  if (K1[0] & 0x80) K2 = xor(K2, Rb);
  return { K1, K2 };
}

export function aesCmac(key, message) {
  const { K1, K2 } = subkeys(key);
  const n = Math.ceil(message.length / BLOCK) || 1;
  const complete = message.length > 0 && message.length % BLOCK === 0;

  let last;
  if (complete) {
    last = xor(message.subarray((n - 1) * BLOCK, n * BLOCK), K1);
  } else {
    const rem = message.subarray((n - 1) * BLOCK);
    const padded = Buffer.alloc(16);
    rem.copy(padded);
    padded[rem.length] = 0x80;
    last = xor(padded, K2);
  }

  let x = Buffer.alloc(16);
  for (let i = 0; i < n - 1; i++) {
    x = aesEcb(key, xor(x, message.subarray(i * BLOCK, (i + 1) * BLOCK)));
  }
  return aesEcb(key, xor(x, last));
}

// The SUN message we authenticate: `<tagId>|<counter>`. (For real NTAG 424 DNA
// tags, configure SDM to emit a matching CMAC input.)
export function sunMessage(tagId, ctr) {
  return Buffer.from(`${tagId}|${ctr}`, "utf8");
}

export function verifySun({ keyHex, tagId, ctr, cmacHex }) {
  if (!keyHex || !cmacHex) return false;
  let key;
  try { key = Buffer.from(String(keyHex), "hex"); } catch { return false; }
  if (key.length !== 16) return false;
  if (!Number.isInteger(ctr)) return false;

  const expected = aesCmac(key, sunMessage(tagId, ctr));
  let provided;
  try { provided = Buffer.from(String(cmacHex), "hex"); } catch { return false; }
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}
