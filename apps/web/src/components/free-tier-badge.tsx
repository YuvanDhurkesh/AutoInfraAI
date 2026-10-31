import type { FreeTierFit } from "@autoinfra/shared";

const STYLES: Record<FreeTierFit, { label: string; className: string }> = {
  within_limits: {
    label: "✅ Within Free Tier",
    className: "border-emerald-700 bg-emerald-950/50 text-emerald-300",
  },
  near_limit: {
    label: "⚠️ Near Free Tier limit",
    className: "border-amber-700 bg-amber-950/50 text-amber-300",
  },
  exceeds: {
    label: "❌ Exceeds Free Tier",
    className: "border-red-700 bg-red-950/50 text-red-300",
  },
};

export function FreeTierBadge({ fit }: { fit: FreeTierFit }) {
  const style = STYLES[fit];
  return (
    <span
      className={`inline-block rounded-full border px-3 py-1 text-sm font-medium ${style.className}`}
    >
      {style.label}
    </span>
  );
}
