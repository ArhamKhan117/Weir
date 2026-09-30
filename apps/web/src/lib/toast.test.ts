import { describe, expect, it } from "vitest";

import { currentToasts, dismiss, toast, withTransactionToast } from "./toast";

const shown = () => [...currentToasts()];

const labels = { pending: "Pausing Netflix", success: "Paused Netflix", failure: "Could not pause Netflix" };

describe("transaction toasts", () => {
  it("replaces the pending toast with a confirmation that links the transaction", async () => {
    const result = await withTransactionToast(labels, async () => ({ ok: true as const, value: "0xabc" as const }), (hash) => hash);
    expect(result).toEqual({ ok: true, value: "0xabc" });
    expect(shown()).toContainEqual(expect.objectContaining({ kind: "success", title: "Paused Netflix", transaction: "0xabc" }));
  });

  it("shows the reason when it fails, and nothing when the person cancelled", async () => {
    await withTransactionToast(labels, async () => ({ ok: false as const, cancelled: false, message: "MandateExpired" }), () => undefined);
    expect(shown()).toContainEqual(expect.objectContaining({ kind: "error", title: "Could not pause Netflix" }));
    const before = (shown()).length;
    await withTransactionToast(labels, async () => ({ ok: false as const, cancelled: true, message: "" }), () => undefined);
    expect((shown()).length).toBe(before);
  });

  it("dismisses on request", async () => {
    const id = toast.error("Something");
    dismiss(id);
    expect((shown()).some((t) => t.title === "Something")).toBe(false);
  });
});
