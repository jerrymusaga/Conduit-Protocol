"use client";
/**
 * A small fixed toast for action feedback — important because embedded/passkey
 * wallets sign SILENTLY (no wallet popup), so on mobile a grant/run can look
 * like nothing happened. Pairs with the activity log, surfaced front-and-center.
 */
export type ToastState = { kind: "pending" | "success" | "error"; text: string } | null;

const STYLES: Record<NonNullable<ToastState>["kind"], string> = {
  pending: "border-conduit-violet/40 bg-conduit-violet/15",
  success: "border-conduit-cyan/40 bg-conduit-cyan/15",
  error: "border-conduit-magenta/40 bg-conduit-magenta/15",
};

export function Toast({ toast }: { toast: ToastState }) {
  if (!toast) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex justify-center px-4">
      <div
        className={`pointer-events-auto flex max-w-[92vw] items-center gap-2.5 rounded-xl border px-4 py-2.5 text-sm text-white shadow-glow-violet backdrop-blur ${STYLES[toast.kind]}`}
        role="status"
        aria-live="polite"
      >
        {toast.kind === "pending" ? (
          <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-white/30 border-t-white" />
        ) : (
          <span className="shrink-0">{toast.kind === "success" ? "✓" : "✗"}</span>
        )}
        <span className="leading-snug">{toast.text}</span>
      </div>
    </div>
  );
}
