/**
 * A designed placeholder for a generated illustration/animation. Looks
 * intentional (glowing dashed frame) until you drop in the real asset.
 *
 * To replace: swap <IllustrationSlot .../> for a Next <Image> or a <video>
 * pointing at the generated file in /public/images. The `id` matches the
 * prompt in ILLUSTRATIONS.md.
 */
export function IllustrationSlot({
  id,
  label,
  aspect = "16 / 9",
  className = "",
}: {
  id: string;
  label: string;
  aspect?: string;
  className?: string;
}) {
  return (
    <div
      className={`relative w-full overflow-hidden rounded-2xl ${className}`}
      style={{ aspectRatio: aspect }}
    >
      {/* glow frame */}
      <div className="absolute inset-0 rounded-2xl border border-dashed border-conduit-violet/40" />
      <div
        className="absolute inset-0 rounded-2xl opacity-60"
        style={{
          background:
            "radial-gradient(40rem 20rem at 50% 120%, rgba(124,58,237,0.18), transparent 60%), radial-gradient(30rem 16rem at 20% -20%, rgba(0,229,255,0.16), transparent 60%)",
        }}
      />
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <div className="mono text-xs uppercase tracking-widest text-conduit-cyan/80">
            illustration slot
          </div>
          <div className="mt-2 text-lg font-semibold text-white/90">{label}</div>
          <div className="mono mt-1 text-xs text-conduit-muted">
            id: {id} · see ILLUSTRATIONS.md
          </div>
        </div>
      </div>
    </div>
  );
}
