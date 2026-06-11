import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { PlaybackModeProvider, LocalPlayerProvider } from "./lib/localPlayer";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PlaybackModeProvider>
      <LocalPlayerProvider>
        <App />
      </LocalPlayerProvider>
    </PlaybackModeProvider>
  </React.StrictMode>
);

