import React from "react";

export function SectionHeader({ eyebrow, title, description, align = "left", tone = "default", actions, style, className }) {
  const inverse = tone === "inverse";
  return (
    <div className={className} style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: align === "center" ? 760 : 720, marginInline: align === "center" ? "auto" : 0, textAlign: align, alignItems: align === "center" ? "center" : "flex-start", ...style }}>
      {eyebrow ? (
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--type-eyebrow-size)", fontWeight: "var(--fw-semibold)", letterSpacing: "var(--type-eyebrow-tracking)", textTransform: "uppercase", color: inverse ? "var(--coral-400)" : "var(--text-brand)" }}>{eyebrow}</span>
      ) : null}
      {title ? (
        <h2 style={{ fontSize: "var(--type-display-md-size)", lineHeight: "var(--type-display-md-line)", letterSpacing: "var(--type-display-md-tracking)", color: inverse ? "var(--text-inverse)" : "var(--text-primary)", textWrap: "balance" }}>{title}</h2>
      ) : null}
      {description ? (
        <p style={{ fontSize: "var(--type-body-lg-size)", lineHeight: "var(--type-body-lg-line)", color: inverse ? "var(--text-inverse-muted)" : "var(--text-secondary)" }}>{description}</p>
      ) : null}
      {actions ? <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 6 }}>{actions}</div> : null}
    </div>
  );
}
