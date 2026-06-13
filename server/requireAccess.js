// Drop-in Express middleware for any Harmonizer Labs property to gate routes
// through the central hl-auth service. Copy this file into the app (ESM), or
// import it from a shared location. Zero dependencies — uses global fetch.
//
// Usage (e.g. in cloud-squeeze server/app.js):
//   import { requireAccess } from "./requireAccess.js";
//   app.use(requireAccess("cloud-squeeze"));           // gate everything, or
//   app.use("/private", requireAccess("cloud-squeeze")); // gate a subtree
//
// Env the app should set:
//   AUTH_INTERNAL_URL = http://127.0.0.1:4200   (hl-auth, localhost only)
//   AUTH_PUBLIC_BASE  = /auth                    (public base path for redirects)
//   AUTH_INTERNAL_KEY = <same as hl-auth INTERNAL_KEY>  (optional but recommended)
//   AUTH_COOKIE_NAME  = hl_session
//
// LOCAL-NEVER-LOCKED-OUT (important safety property):
//   The gate ONLY enforces on requests that arrived through the public nginx
//   (which always sets X-Forwarded-For / the public marker). A request made
//   DIRECTLY to the app on the box (e.g. `curl 127.0.0.1:4177/...` over an SSH
//   tunnel) carries no proxy headers and comes from loopback — it is treated as
//   trusted local access and bypasses the gate entirely. So if auth ever breaks
//   or you lock everyone out publicly, you can always reach the app on the VPS.
//   This is safe ONLY because the app port is bound to localhost (not public);
//   the only way to send a non-proxied request is to already be on the machine.
//   Disable with AUTH_LOCAL_BYPASS=0.

// Config is read LAZILY (memoized on first use), not at import time — so it works
// even when the host app populates process.env AFTER importing this module (e.g.
// an app that calls Node's loadEnvFile() in its own body). AUTH_APP_PREFIX is used
// when nginx strips the app's path prefix, so the post-login redirect is correct.
let _cfg = null;
function cfg() {
  if (_cfg) return _cfg;
  _cfg = {
    internalUrl: (process.env.AUTH_INTERNAL_URL || "http://127.0.0.1:4200").replace(/\/$/, ""),
    publicBase: (process.env.AUTH_PUBLIC_BASE || "/auth").replace(/\/$/, ""),
    internalKey: process.env.AUTH_INTERNAL_KEY || "",
    serviceKey: process.env.AUTH_SERVICE_KEY || "", // trusted backend-to-backend key (X-HL-Service-Key)
    cookieName: process.env.AUTH_COOKIE_NAME || "hl_session",
    cacheTtlMs: Number(process.env.AUTH_CACHE_TTL_MS || 60000), // = revocation latency
    verifyTimeoutMs: Number(process.env.AUTH_VERIFY_TIMEOUT_MS || 2500),
    localBypass: process.env.AUTH_LOCAL_BYPASS !== "0", // default ON
    publicMarker: (process.env.AUTH_PUBLIC_MARKER || "x-hl-gate").toLowerCase(),
    appPrefix: (process.env.AUTH_APP_PREFIX || "").replace(/\/$/, "")
  };
  return _cfg;
}

const cache = new Map(); // `${token}|${page}` -> { decision, exp }

function isLoopback(ip) {
  const a = String(ip || "").replace(/^::ffff:/, "");
  return a === "" || a === "127.0.0.1" || a === "::1";
}

/**
 * A request reached the app WITHOUT going through the public nginx: it has no
 * proxy/forwarding markers and the peer is loopback. Only an on-box process can
 * produce this, so it is trusted (never gated).
 */
function isLocalDirect(req) {
  const viaProxy = req.headers["x-forwarded-for"] || req.headers[cfg().publicMarker];
  if (viaProxy) return false;
  const peer = req.socket?.remoteAddress || req.connection?.remoteAddress;
  return isLoopback(peer);
}

function readCookie(req, name) {
  const raw = req.headers?.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

async function verify(token, page) {
  const key = `${token || ""}|${page}`;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.decision;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), cfg().verifyTimeoutMs);
  let decision;
  try {
    const url = `${cfg().internalUrl}/internal/verify?page=${encodeURIComponent(page)}`;
    const res = await fetch(url, {
      headers: { "x-session-token": token || "", "x-internal-key": cfg().internalKey },
      signal: ctrl.signal
    });
    decision = await res.json();
  } catch {
    decision = { authenticated: false, allowed: false, reason: "verify_unreachable" }; // FAIL CLOSED
  } finally {
    clearTimeout(t);
  }
  cache.set(key, { decision, exp: Date.now() + cfg().cacheTtlMs });
  return decision;
}

/**
 * Decide access for a request without touching the response. Usable by both the
 * HTTP middleware and non-HTTP gates (e.g. a WebSocket handshake).
 * Returns { ok, status, user, local, reason }.
 */
export async function checkAccess(req, page) {
  if (cfg().localBypass && isLocalDirect(req)) {
    return { ok: true, local: true, user: { username: "local", isMaster: true, local: true }, reason: "local_bypass" };
  }
  // Trusted backend-to-backend caller (e.g. another VPS app) presenting the shared
  // service key. Authorized for any page, but NOT admin.
  const svc = req.headers["x-hl-service-key"];
  if (cfg().serviceKey && svc && svc === cfg().serviceKey) {
    return { ok: true, service: true, user: { username: "service", service: true }, reason: "service_key" };
  }
  // May be null — public pages are still allowed (verify decides by page mode).
  const token = readCookie(req, cfg().cookieName);
  const d = await verify(token, page);
  if (d.allowed) return { ok: true, user: d.user || { public: true }, public: Boolean(d.public), reason: d.reason || "ok" };
  if (d.authenticated && !d.allowed) return { ok: false, status: 403, reason: d.reason || "not_authorized", user: d.user };
  return { ok: false, status: 401, reason: d.reason || "unauthenticated" };
}

/**
 * Gate a route by page id. On allow, attaches req.hlUser. On deny:
 *  - not authenticated -> 302 to the central login with ?next=<current url>
 *  - authenticated but unauthorized -> 403
 */
export function requireAccess(page) {
  return async (req, res, next) => {
    const r = await checkAccess(req, page);
    if (r.ok) { req.hlUser = r.user; return next(); }
    if (r.status === 403) {
      return res.status(403).type("html").send(
        `<!doctype html><meta charset=utf-8><body style="font-family:system-ui;background:#0b0c10;color:#e8e8ea;padding:40px">
         <h1>403 — no access</h1><p>Your account can't open this page. Ask the admin for access.</p>
         <p><a style="color:#7aa2ff" href="${cfg().publicBase}/account">Your account</a></p></body>`
      );
    }
    return redirectToLogin(req, res);
  };
}

function redirectToLogin(req, res) {
  const prefix = req.headers["x-forwarded-prefix"] || cfg().appPrefix || "";
  const next = encodeURIComponent(prefix + (req.originalUrl || "/"));
  res.redirect(`${cfg().publicBase}/login?next=${next}`);
}

/** Optional: clear cached decisions (e.g. on an admin webhook). */
export function clearAuthCache() {
  cache.clear();
}
