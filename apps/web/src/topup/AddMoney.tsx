/**
 * "Add money": dollars from any chain into a Weir account, through NEAR Intents with Aurora's
 * widget. Top up gives a deposit address for whatever the person holds, wherever it is, so an
 * exchange withdrawal works as well as a wallet; Swap connects the wallet that holds it. Either
 * way it arrives in the Weir account as USDC on Monad, the only thing either tab can deliver.
 *
 * The widget and the chain SDKs behind it are large, so they load when the dialog first opens.
 * The dialog is a portal rather than a modal `<dialog>`: a modal one makes the rest of the page
 * inert, and the wallet picker the Swap tab opens is attached to the page body.
 */

import { Component, lazy, Suspense, useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Address } from "viem";

import { Alert, Button, Skeleton } from "../components/ui";
import { IS_TESTNET } from "../lib/config";
import { shortAddress } from "../lib/format";

const TopUpWidget = lazy(() => import("./TopUpWidget"));

type Mode = "topup" | "swap";

const MODES: Readonly<Record<Mode, { label: string; copy: string }>> = {
  topup: {
    label: "Top up",
    copy: "Send dollars or crypto from any chain: another wallet, or a withdrawal from an exchange.",
  },
  swap: {
    label: "Swap",
    copy: "Connect a wallet and swap what it holds on any chain.",
  },
};
const ORDER: readonly Mode[] = ["topup", "swap"];

export function AddMoneyButton({
  recipient,
  onClosed,
  variant = "secondary",
  block = false,
  size,
  children = "Add money",
}: {
  /** The Weir account the money goes to. */
  recipient: Address;
  /** Called when the dialog closes, to read the balance again. */
  onClosed?: () => void;
  variant?: "primary" | "secondary" | "ghost";
  block?: boolean;
  size?: "sm" | "md" | "lg";
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
    onClosed?.();
  }, [onClosed]);
  return (
    <>
      <Button ref={trigger} variant={variant} block={block} size={size} onClick={() => setOpen(true)}>
        {children}
      </Button>
      {open ? <AddMoneyDialog recipient={recipient} onClose={close} /> : null}
    </>
  );
}

function AddMoneyDialog({ recipient, onClose }: { recipient: Address; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>("topup");
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape belongs to whatever is on top: the wallet prompt Privy opens above this dialog, or
      // the widget's token list. Both are modal dialogs of their own, portalled outside this one.
      const above = Array.from(document.querySelectorAll('[aria-modal="true"]')).some((dialog) => dialog !== panel.current);
      const target = event.target instanceof Element ? event.target : null;
      if (!above && !target?.closest(".sw")) onClose();
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  return createPortal(
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={panel} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="dialog-head">
          <h2 id={titleId} className="dialog-title">
            Add money
          </h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <path d="M4.5 4.5l9 9M13.5 4.5l-9 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="dialog-body">
          <div className="segmented" role="tablist" aria-label="How to add money">
            {ORDER.map((id) => (
              <button key={id} type="button" role="tab" aria-selected={id === mode} className="segment" onClick={() => setMode(id)}>
                {MODES[id].label}
              </button>
            ))}
          </div>
          <p className="dialog-copy">
            {MODES[mode].copy} It arrives as USDC on Monad in your Weir account,{" "}
            <span className="mono">{shortAddress(recipient)}</span>.
          </p>
          {IS_TESTNET ? (
            <Alert tone="caution">
              Preview: this moves real money and delivers it on Monad Mainnet, not Testnet. Use test dollars here.
            </Alert>
          ) : null}

          <div className="topup-widget" role="tabpanel">
            <LoadFailure>
              <Suspense fallback={<Skeleton height={440} />}>
                <TopUpWidget key={mode} mode={mode} recipient={recipient} />
              </Suspense>
            </LoadFailure>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Keeps a widget that fails to load, or throws, inside the dialog: the rest of the page stays as
 * it was. A failed chunk usually means the site was updated since this page loaded, which only a
 * reload fixes, since the browser keeps the failed import.
 */
class LoadFailure extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Alert tone="negative">
        Add money did not load.{" "}
        <button type="button" className="link" onClick={() => window.location.reload()}>
          Reload the page
        </button>{" "}
        and try again.
      </Alert>
    );
  }
}
