import React from "react";
import { Button } from "../core/Button.jsx";
import { Icon } from "../core/Icon.jsx";
import { Media } from "./Media.jsx";

export function Hero({ eyebrow, title, description, primaryCta, secondaryCta, bullets, media, tone = "canvas", align = "split", trustLine, onAction, style, className }) {
  const inverse = tone === "inverse";
  const wrap = {
    background: inverse ? "var(--surface-inverse)" : tone === "sunken" ? "var(--surface-sunken)" : "var(--surface-canvas)",
    color: inverse ? "var(--text-inverse)" : "var(--text-primary)",
    paddingBlock: "var(--space-13)",
    borderBottom: inverse ? "none" : "1px solid var(--border-subtle)",
    ...style,
  };
  const centered = align === "center";
  const copy = (
    <div style={{ display: "flex", flexDirection: "column", alignItems: centered ? "center" : "flex-start", textAlign: centered ? "center" : "left", maxWidth: centered ? 820 : 560, marginInline: centered ? "auto" : 0 }}>
      {eyebrow ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: "var(--font-mono)", fontSize: "var(--type-eyebrow-size)", fontWeight: "var(--fw-semibold)", letterSpacing: "var(--type-eyebrow-tracking)", textTransform: "uppercase", color: inverse ? "var(--coral-400)" : "var(--text-brand)", marginBottom: 18 }}>{eyebrow}</span>
      ) : null}
      <h1 style={{ fontSize: centered ? "var(--type-display-2xl-size)" : "var(--type-display-xl-size)", lineHeight: centered ? "var(--type-display-2xl-line)" : "var(--type-display-xl-line)", letterSpacing: centered ? "var(--type-display-2xl-tracking)" : "var(--type-display-xl-tracking)", color: "inherit", textWrap: "balance" }} className="c4t-hero-title">{title}</h1>
      {description ? (
        <p style={{ marginTop: 20, fontSize: "var(--type-body-lg-size)", lineHeight: "var(--type-body-lg-line)", color: inverse ? "var(--text-inverse-muted)" : "var(--text-secondary)", maxWidth: 540 }}>{description}</p>
      ) : null}
      {bullets && bullets.length ? (
        <ul style={{ listStyle: "none", margin: "24px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 10, textAlign: "left" }}>
          {bullets.map((b) => (
            <li key={b} style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: "var(--type-body-md-size)", color: inverse ? "var(--text-inverse-muted)" : "var(--text-secondary)" }}>
              <Icon name="check" size={18} style={{ color: "var(--coral-500)", marginTop: 3 }} />{b}
            </li>
          ))}
        </ul>
      ) : null}
      {primaryCta || secondaryCta ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 32, justifyContent: centered ? "center" : "flex-start" }}>
          {primaryCta ? <Button size="lg" variant={inverse ? "primary" : "primary"} iconRight="arrow-right" onClick={() => onAction && onAction(primaryCta)}>{primaryCta}</Button> : null}
          {secondaryCta ? <Button size="lg" variant={inverse ? "inverse-ghost" : "secondary"} onClick={() => onAction && onAction(secondaryCta)}>{secondaryCta}</Button> : null}
        </div>
      ) : null}
      {trustLine ? (
        <p style={{ marginTop: 20, fontSize: "var(--type-caption-size)", color: inverse ? "var(--text-inverse-muted)" : "var(--text-muted)" }}>{trustLine}</p>
      ) : null}
    </div>
  );

  return (
    <section className={className} style={wrap}>
      <div style={{ maxWidth: "var(--container-max)", margin: "0 auto", paddingInline: "var(--container-gutter)" }}>
        {centered ? (
          <>
            {copy}
            {media !== false ? <div style={{ marginTop: 56 }}>{media || <Media ratio="21 / 9" label="Product view" icon="monitor" tone={inverse ? "inverse" : "sunken"} />}</div> : null}
          </>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1.05fr 1fr", gap: 56, alignItems: "center" }} className="c4t-hero-split">
            {copy}
            <div>{media || <Media ratio="4 / 3" label="Product view" icon="monitor" tone={inverse ? "inverse" : "sunken"} />}</div>
          </div>
        )}
      </div>
    </section>
  );
}
