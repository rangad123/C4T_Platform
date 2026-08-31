import React from "react";
import { Icon } from "../core/Icon.jsx";
import { Badge } from "../core/Badge.jsx";

export function ServiceCard({ icon, eyebrow, title, description, points = [], cta = "Explore", badge, onClick, href, style, className }) {
  return (
    <a
      href={href || "#"}
      onClick={onClick}
      className={["c4t-card-hover", className].filter(Boolean).join(" ")}
      style={{ display: "flex", flexDirection: "column", padding: "var(--space-card-padding-lg)", background: "var(--surface-canvas)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-card)", textDecoration: "none", color: "inherit", height: "100%", ...style }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        {icon ? <Icon name={icon} size={24} style={{ color: "var(--coral-500)" }} /> : null}
        {eyebrow ? <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-muted)" }}>{eyebrow}</span> : null}
        {badge ? <span style={{ marginLeft: "auto" }}><Badge tone="brand">{badge}</Badge></span> : null}
      </div>
      <h3 style={{ fontSize: "var(--type-heading-md-size)", lineHeight: "var(--type-heading-md-line)", letterSpacing: "var(--type-heading-md-tracking)" }}>{title}</h3>
      {description ? <p style={{ marginTop: 10, fontSize: "var(--type-body-sm-size)", lineHeight: 1.6, color: "var(--text-secondary)" }}>{description}</p> : null}
      {points.length ? (
        <ul style={{ listStyle: "none", margin: "18px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {points.map((p) => (
            <li key={p} style={{ display: "flex", gap: 8, fontSize: "var(--type-body-sm-size)", color: "var(--text-secondary)" }}>
              <Icon name="check" size={16} style={{ color: "var(--teal-500)", marginTop: 3 }} />{p}
            </li>
          ))}
        </ul>
      ) : null}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: "auto", paddingTop: 24, fontSize: "var(--type-body-sm-size)", fontWeight: "var(--fw-medium)", color: "var(--text-brand)" }}>
        {cta} <Icon name="arrow-right" size={15} />
      </span>
    </a>
  );
}
