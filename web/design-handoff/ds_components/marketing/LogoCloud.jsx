import React from "react";

/**
 * Customer logo row. No customer marks were supplied — each cell renders the
 * company name as a wordmark placeholder at reduced contrast. Swap in real SVGs.
 */
export function LogoCloud({ logos = [], label, tone = "canvas", style, className }) {
  const inverse = tone === "inverse";
  return (
    <div className={className} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 28, ...style }}>
      {label ? (
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--type-eyebrow-size)", fontWeight: "var(--fw-semibold)", letterSpacing: "var(--type-eyebrow-tracking)", textTransform: "uppercase", color: inverse ? "var(--text-inverse-muted)" : "var(--text-muted)", textAlign: "center" }}>{label}</span>
      ) : null}
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", alignItems: "center", gap: "28px 56px" }}>
        {logos.map((l) => (
          <span key={l} style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: "var(--fw-semibold)", letterSpacing: "-0.6px", color: inverse ? "var(--text-inverse)" : "var(--ink-400)", opacity: inverse ? 0.7 : 1 }}>{l}</span>
        ))}
      </div>
    </div>
  );
}
