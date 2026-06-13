import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import "./tap.css";
import { TapNow } from "./TapNow";
import { TapWrite } from "./TapWrite";

// The SPA is served under a mount prefix (the Vite base, e.g. "/cloud-squeeze")
// via nginx, which strips the prefix before the app sees it. A root-absolute
// "/api/..." call would bypass the prefix and miss the app entirely (404 at the
// site root). Prefix same-origin "/api/..." requests with the mount base so every
// API call lands on the app regardless of where it's mounted. No-op when the base
// is "/" (app served at root). Does NOT touch "/auth/..." (hl-auth lives at root)
// or absolute URLs. One place => covers the tapper, the console, and future calls.
(() => {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, "");
  if (!base) return;
  const orig = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === "string" && input.startsWith("/api/")) input = base + input;
    else if (input instanceof URL && input.origin === location.origin && input.pathname.startsWith("/api/")) {
      input = new URL(base + input.pathname + input.search + input.hash, location.origin);
    }
    return orig(input as RequestInfo | URL, init);
  };
})();

// The console (search/bind/QR/manage) is lazy-loaded so the public tapper page
// never downloads it — the tapper bundle stays tiny.
const TapConsole = React.lazy(() => import("./TapConsole").then((m) => ({ default: m.TapConsole })));

// Demo states render a fixed UI with no backend so the design can be previewed
// and battery-tested per state by URL, e.g. /tap/t/demo?state=playing&long=1.
function demoFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const name = params.get("state");
  if (!name) return undefined;
  const long = params.get("long") === "1";
  const title = long
    ? "Aufstellungsorientierungsschwierigkeiten (The Extended Director's Cut Remaster Anniversary Edition)"
    : "Punisher";
  const artist = long ? "An Artist With An Extraordinarily Long Collaborative Name & The Ensemble" : "Phoebe Bridgers";
  switch (name) {
    case "loading":
      return { phase: "loading" } as const;
    case "playing":
      return { phase: "playing", debounced: false, display: { title, artist, art: null }, where: "the Boom", tapCount: 12 } as const;
    case "debounced":
      return { phase: "playing", debounced: true, display: { title, artist, art: null }, where: "the Boom", tapCount: 13 } as const;
    case "unbound":
      return { phase: "error", reason: "unbound", title: "This tag isn't set up yet", body: "Bind it to an album in the Tap console and it'll play the moment you tap.", offerConsole: true } as const;
    case "speaker_offline":
      return { phase: "error", reason: "speaker_offline", title: "The speaker's offline", body: "Wake the Squeezebox, give it a moment, then tap again." } as const;
    default:
      return undefined;
  }
}

function render() {
  const path = window.location.pathname;
  const params = new URLSearchParams(window.location.search);
  const tagMatch = path.match(/\/tap\/t\/([^/]+)\/?$/);
  // `?view=now` lets the tapper page render at the entry path (e.g. on the dev
  // server / battery) without the /tap/t/:id rewrite.
  if (tagMatch || params.get("view") === "now") {
    return <TapNow tagId={tagMatch ? decodeURIComponent(tagMatch[1]) : "demo"} demo={demoFromQuery()} />;
  }
  // The "write" page a phone reaches by scanning the console's QR — writes the
  // tag via Web NFC, never plays.
  const writeMatch = path.match(/\/tap\/write\/([^/]+)\/?$/);
  if (writeMatch || params.get("view") === "write") {
    return <TapWrite tagId={writeMatch ? decodeURIComponent(writeMatch[1]) : "demo"} />;
  }
  return (
    <Suspense fallback={<div className="tap-state"><span className="tap-spinner" aria-label="Loading" /></div>}>
      <TapConsole />
    </Suspense>
  );
}

ReactDOM.createRoot(document.getElementById("tap-root")!).render(<React.StrictMode>{render()}</React.StrictMode>);
