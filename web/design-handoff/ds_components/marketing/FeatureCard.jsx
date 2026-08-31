import React from "react";
import { Icon } from "../core/Icon.jsx";

export function FeatureCard({ icon, title, description, meta, href, onClick, tone = "canvas", style, className }) {
  const inverse = tone === "inverse";
  const Tag = href || onClick ? "a" : "div";
  return (
    <Tag
      href={href}
      onClick={onClick}
      className={["c4t-card-hover", className].filter(Boolean).join(" ")}
      style={{
        display: "block",
        padding: "var(--space-card-padding)",
        background: inverse ? "var(--surface-inverse-raised)" : "var(--surface-canvas)",
        border: `1px solid ${inverse ? "var(--border-inverse)" : "var(--border-default)"}`,
        borderRadius: "var(--radius-card)",
        textDecoration: "none",
        color: "inherit",
        cursor: href || onClick ? "pointer" : "default",
        ...style,
      }}
    >
      {icon ? (
        <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 44, height: 44, borderRadius: "var(--radius-sm)", background: inverse ? "rgb(255 255 255 / 0.07)" : "var(--surface-brand-subtle)", color: "var(--coral-500)", marginBottom: 18 }}>
          <Icon name={icon} size={22} />
        </span>
      ) : null}
      <h3 style={{ fontSize: "var(--type-heading-sm-size)", lineHeight: "var(--type-heading-sm-line)", letterSpacing: "var(--type-heading-sm-tracking)", color: inverse ? "var(--text-inverse)" : "var(--text-primary)" }}>{title}</h3>
      {description ? (
        <p style={{ marginTop: 8, fontSize: "var(--type-body-sm-size)", lineHeight: "var(--type-body-sm-line)", color: inverse ? "var(--text-inverse-muted)" : "var(--text-secondary)" }}>{description}</p>
      ) : null}
      {meta ? (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${inverse ? "var(--border-inverse)" : "var(--border-subtle)"}`, fontFamily: "var(--font-mono)", fontSize: 12, color: inverse ? "var(--text-inverse-muted)" : "var(--text-muted)" }}>{meta}</div>
      ) : null}
    </Tag>
  );
}
