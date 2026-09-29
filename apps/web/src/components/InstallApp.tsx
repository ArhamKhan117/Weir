import { useEffect, useState } from "react";

import { Mark } from "./Logo";

/** Chrome's install prompt event, which TypeScript's DOM types do not name. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISSED = "weir.install-dismissed";

function standalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function iosSafari(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

let deferred: InstallPromptEvent | undefined;
const waiting = new Set<() => void>();
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    for (const notify of waiting) notify();
  });
}

/**
 * Weir on the home screen, on a phone: an Install button where the browser offers one (Android),
 * the two taps it takes on an iPhone, and nothing on a computer, inside the installed app, or once
 * dismissed.
 */
export function InstallApp() {
  const [, rerender] = useState(0);
  const [hidden, setHidden] = useState(() => {
    try {
      return standalone() || window.localStorage.getItem(DISMISSED) === "1";
    } catch {
      return standalone();
    }
  });
  const [phone, setPhone] = useState(() => window.matchMedia("(max-width: 860px)").matches);

  useEffect(() => {
    const notify = () => rerender((n) => n + 1);
    waiting.add(notify);
    const query = window.matchMedia("(max-width: 860px)");
    const onChange = () => setPhone(query.matches);
    query.addEventListener("change", onChange);
    window.addEventListener("appinstalled", () => setHidden(true));
    return () => {
      waiting.delete(notify);
      query.removeEventListener("change", onChange);
    };
  }, []);

  const ios = iosSafari();
  if (hidden || !phone || (deferred === undefined && !ios)) return null;

  function dismiss() {
    setHidden(true);
    try {
      window.localStorage.setItem(DISMISSED, "1");
    } catch {
      // Shown again next visit.
    }
  }

  async function install() {
    const event = deferred;
    if (event === undefined) return;
    await event.prompt();
    const { outcome } = await event.userChoice;
    deferred = undefined;
    if (outcome === "accepted") setHidden(true);
    else rerender((n) => n + 1);
  }

  return (
    <div className="install-app rise" role="region" aria-label="Install Weir">
      <span className="install-app-icon" aria-hidden="true">
        <Mark />
      </span>
      <div className="install-app-copy">
        <strong>Get the Weir app</strong>
        <span>{ios ? "Tap Share, then Add to Home Screen." : "Open Weir from your home screen, like any app."}</span>
      </div>
      {ios ? null : (
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void install()}>
          Install
        </button>
      )}
      <button type="button" className="toast-close" aria-label="Not now" onClick={dismiss}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
