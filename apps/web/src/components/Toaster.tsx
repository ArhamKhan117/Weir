import { dismiss, transactionUrl, useToasts, type Toast } from "../lib/toast";

/** The corner where toasts appear. Screen readers hear each one as it arrives. */
export function Toaster() {
  const toasts = useToasts();
  return (
    <div className="toaster" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastCard({ toast }: { toast: Toast }) {
  const href = toast.transaction === undefined ? undefined : transactionUrl(toast.transaction);
  return (
    <div className="toast" data-kind={toast.kind} role={toast.kind === "error" ? "alert" : "status"}>
      <span className="toast-icon" aria-hidden="true">
        {toast.kind === "pending" ? <span className="toast-spinner" /> : toast.kind === "success" ? <Check /> : <Cross />}
      </span>
      <div className="toast-copy">
        <strong>{toast.title}</strong>
        {toast.body === undefined ? null : <span>{toast.body}</span>}
        {href === undefined ? null : (
          <a href={href} target="_blank" rel="noreferrer">
            View transaction
          </a>
        )}
      </div>
      {toast.kind === "pending" ? null : (
        <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
          <Cross />
        </button>
      )}
    </div>
  );
}

function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3 7.4l2.6 2.6L11 4.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Cross() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
