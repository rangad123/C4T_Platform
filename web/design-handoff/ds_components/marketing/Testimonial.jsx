import React from "react";
import { Icon } from "../core/Icon.jsx";

export function Testimonial({ quote, name, role, company, metric, metricLabel, tone = "canvas", variant = "card", style, className }) {
  const inverse = tone === "inverse";
  const fg = inverse ? "var(--text-inverse)" : "var(--text-primary)";
  const muted = inverse ? "var(--text-inverse-muted)" : "var(--text-muted)";
  const isFeature = variant === "feature";
  return (
    <figure
      className={className}
      style={{
        margin: 0,
        padding: isFeature ? 0 : "var(--space-card-padding-lg)",
        background: isFeature ? "transparent" : inverse ? "var(--surface-inverse-raised)" : "var(--surface-canvas)",
        border: isFeature ? "none" : `1px solid ${inverse ? "var(--border-inverse)" : "var(--border-default)"}`,
        borderRadius: "var(--radius-card)",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        ...style,
      }}
    >
      <Icon name="quote" size={isFeature ? 28 : 20} style={{ color: "var(--coral-500)", marginBottom: 16 }} />
      <blockquote style={{ margin: 0, fontSize: isFeature ? "var(--type-heading-md-size)" : "var(--type-body-md-size)", lineHeight: isFeature ? 1.45 : 1.6, letterSpacing: isFeature ? "-0.25px" : 0, color: fg, textWrap: "pretty" }}>
        {quote}
      </blockquote>
      {metric ? (
        <div style={{ marginTop: 24, paddingTop: 20, borderTop: `1px solid ${inverse ? "var(--border-inverse)" : "var(--border-subtle)"}` }}>
          <div style={{ fontSize: 32, fontWeight: "var(--fw-semibold)", letterSpacing: "-1px", color: fg, fontVariantNumeric: "tabular-nums" }}>{metric}</div>
          <div style={{ fontSize: "var(--type-caption-size)", color: muted, marginTop: 2 }}>{metricLabel}</div>
        </div>
      ) : null}
      <figcaption style={{ marginTop: "auto", paddingTop: 24, display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 40, height: 40, flex: "none", borderRadius: 999, background: inverse ? "rgb(255 255 255 / 0.1)" : "var(--surface-muted)", color: inverse ? "var(--text-inverse)" : "var(--text-secondary)", fontSize: 14, fontWeight: "var(--fw-semibold)" }}>
          {(name || "").split(" ").map((w) => w[0]).slice(0, 2).join("")}
        </span>
        <span>
          <span style={{ display: "block", fontSize: "var(--type-body-sm-size)", fontWeight: "var(--fw-medium)", color: fg }}>{name}</span>
          <span style={{ display: "block", fontSize: "var(--type-caption-size)", color: muted }}>{role}{company ? `, ${company}` : ""}</span>
        </span>
      </figcaption>
    </figure>
  );
}
