import React from "react";
import ReactDOM from "react-dom/client";
import "./tap.css";
import { TapNow } from "./TapNow";
import { TapConsole } from "./TapConsole";

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
  return <TapConsole />;
}

ReactDOM.createRoot(document.getElementById("tap-root")!).render(<React.StrictMode>{render()}</React.StrictMode>);
