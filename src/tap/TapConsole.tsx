import React from "react";

// Tap console shell (expandable nav). The full search → bind → Web NFC write +
// tag manager is built in loop 10; this establishes the shell + sections so new
// areas (Analytics, Stations) slot in without restructuring.
const NAV = [
  { key: "tags", label: "Tags", current: true },
  { key: "write", label: "Write a tag" },
  { key: "analytics", label: "Analytics", soon: true },
  { key: "stations", label: "Reader stations", soon: true }
];

export function TapConsole() {
  return (
    <div className="tap-shell">
      <nav className="tap-nav" aria-label="Tap console">
        <div className="tap-nav__brand"><span className="tap-wordmark"><span className="tap-wordmark__dot" aria-hidden="true" />Tap</span></div>
        {NAV.map((item) => (
          <a key={item.key} className="tap-nav__item" href={`#${item.key}`} aria-current={item.current ? "page" : undefined}>
            {item.label}
            {item.soon ? <span className="tap-nav__soon">soon</span> : null}
          </a>
        ))}
      </nav>
      <main className="tap-main">
        <header className="tap-head">
          <span className="tap-head__eyebrow">Tap console</span>
          <h1 className="tap-head__title">Bind tags to your music</h1>
          <p className="tap-head__sub">Sign in to write NFC tags, point them at albums, and manage your collection.</p>
        </header>
        <div className="tap-empty">
          <strong>The console is coming together.</strong>
          <span>Search, bind, write, and manage tags land here next.</span>
        </div>
      </main>
    </div>
  );
}
