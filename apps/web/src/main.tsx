import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { devKeysEnabled } from "./passkey/devkey";
import "./styles/index.css";

// Reads `?devkey=1` or `?devkey=0` on whatever page it arrives on. A no-op outside development.
devKeysEnabled();

const container = document.getElementById("root");
if (container === null) throw new Error("missing #root");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The service worker makes Weir installable on a phone, shows reminders and answers offline.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  });
}
