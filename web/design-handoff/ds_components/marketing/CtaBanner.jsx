import React from "react";
import { Button } from "../core/Button.jsx";

export function CtaBanner({ eyebrow, title, description, primaryCta = "Book a demo", secondaryCta, note, tone = "inverse", onAction, style, className }) {
  const inverse = tone === "inverse";
  const brand = tone === "brand";
  const bg = inverse ? "var(--surface-inverse)" : brand ? "var(--coral-500)" : "var(--surface-sunken)";
  const fg = inverse || brand ? "var(--text-inverse)" : "var(--text-primary)";
  const sub = inverse ? "var(--text-inverse-muted)" : brand ? "rgb(255 255 255 / 0.85)" : "var(--text-secondary)";
  return (
    <section className={className} style={{ background: bg, color: fg, ...style }}>
      <div style={{ maxWidth: "var(--container-max)", margin: "0 auto", padding: "72px var(--container-gutter)", display: "grid", gridTemplateColumns: "1.2fr auto", gap: 40, alignItems: "center" }} className="c4t-cta-grid">
        <div>
          {eyebrow ? (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--type-eyebrow-size)", fontWeight: "var(--fw-semibold)", letterSpacing: "var(--type-eyebrow-tracking)", textTransform: "uppercase", color: brand ? "rgb(255 255 255 / 0.8)" : "var(--coral-400)" }}>{eyebrow}</span>
          ) : null}
          <h2 style={{ marginTop: 12, fontSize: "var(--type-display-md-size)", lineHeight: "var(--type-display-md-line)", letterSpacing: "var(--type-display-md-tracking)", color: fg, maxWidth: 620, textWrap: "balance" }}>{title}</h2>
          {description ? <p style={{ marginTop: 14, fontSize: "var(--type-body-lg-size)", color: sub, maxWidth: 560 }}>{description}</p> : null}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "stretch", minWidth: 220 }}>
          <Button size="lg" variant={brand ? "inverse" : "primary"} iconRight="arrow-right" onClick={() => onAction && onAction(primaryCta)}>{primaryCta}</Button>
          {secondaryCta ? <Button size="lg" variant="inverse-ghost" onClick={() => onAction && onAction(secondaryCta)}>{secondaryCta}</Button> : null}
          {note ? <span style={{ fontSize: "var(--type-caption-size)", color: sub, textAlign: "center" }}>{note}</span> : null}
        </div>
      </div>
    </section>
  );
}
