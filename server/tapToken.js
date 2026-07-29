// Squeezebox Tap — signed-token handshake.
//
// Each tag's URL carries an HMAC over its opaque tagId in the fragment
// (`/tap/t/<id>#k=<token>`). The resolver requires a valid token, so the play
// endpoint can't be triggered by guessing/spraying tag ids. The token is derived
// from the id (not stored), so re-pointing a tag never invalidates its token.
import crypto from "node:crypto";

function secret() {
  const configured = process.env.TAP_TOKEN_SECRET || process.env.CLOUD_SQUEEZE_ADMIN_PASSWORD_HASH;
  if (configured) return configured;
  // Never sign tap tokens with the public dev fallback in production — every
  // static token would be forgeable. Fail loud instead.
  if (process.env.NODE_ENV === "production") {
    throw new Error("TAP_TOKEN_SECRET (or CLOUD_SQUEEZE_ADMIN_PASSWORD_HASH) must be set in production");
  }
  return "tap-dev-secret-change-me";
}

export function signTag(tagId) {
  return crypto.createHmac("sha256", secret()).update(String(tagId)).digest("base64url");
}

export function verifyTag(tagId, token) {
  if (!tagId || !token) return false;
  const expected = signTag(tagId);
  const a = Buffer.from(String(token));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
