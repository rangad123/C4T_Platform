import React from "react";
import { Icon } from "../core/Icon.jsx";
import { Media } from "./Media.jsx";

export function IndustryCard({ icon, name, description, stat, statLabel, href, onClick, style, className }) {
  return (
    <a
      href={href || "#"}
      onClick={onClick}
      className={["c4t-card-hover", className].filter(Boolean).join(" ")}
      style={{ display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--surface-canvas)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-card)", textDecoration: "none", color: "inherit", height: "100%", ...style }}
    >
      <Media ratio="16 / 10" label={name} icon={icon || "image"} tone="sunken" radius="0" style={{ borderWidth: 0, borderBottom: "1px solid var(--border-subtle)" }} />
      <div style={{ padding: "var(--space-card-padding)", display: "flex", flexDirection: "column", flex: 1 }}>
        <h3 style={{ fontSize: "var(--type-heading-sm-size)", letterSpacing: "var(--type-heading-sm-tracking)" }}>{name}</h3>
        {description ? <p style={{ marginTop: 8, fontSize: "var(--type-body-sm-size)", lineHeight: 1.55, color: "var(--text-secondary)" }}>{description}</p> : null}
        {stat ? (
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--border-subtle)" }}>
            <div style={{ fontSize: 24, fontWeight: "var(--fw-semibold)", letterSpacing: "-0.6px", fontVariantNumeric: "tabular-nums" }}>{stat}</div>
            <div style={{ fontSize: "var(--type-caption-size)", color: "var(--text-muted)", marginTop: 2 }}>{statLabel}</div>
          </div>
        ) : null}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: "auto", paddingTop: 20, fontSize: "var(--type-body-sm-size)", fontWeight: "var(--fw-medium)", color: "var(--text-brand)" }}>
          Industry overview <Icon name="arrow-right" size={15} />
        </span>
      </div>
    </a>
  );
}
