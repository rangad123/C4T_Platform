import React from "react";
import { Icon } from "../core/Icon.jsx";

export function Breadcrumb({ items = [], tone = "default", onNavigate, style, className }) {
  const muted = tone === "inverse" ? "var(--text-inverse-muted)" : "var(--text-muted)";
  const strong = tone === "inverse" ? "var(--text-inverse)" : "var(--text-primary)";
  return (
    <nav aria-label="Breadcrumb" className={className} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: "var(--type-body-sm-size)", ...style }}>
      {items.map((item, i) => {
        const label = typeof item === "string" ? item : item.label;
        const last = i === items.length - 1;
        return (
          <React.Fragment key={label}>
            {last ? (
              <span aria-current="page" style={{ color: strong, fontWeight: "var(--fw-medium)" }}>{label}</span>
            ) : (
              <a href="#" onClick={(e) => { e.preventDefault(); onNavigate && onNavigate(label); }} style={{ color: muted, textDecoration: "none" }}>{label}</a>
            )}
            {!last ? <Icon name="chevron-right" size={14} style={{ color: muted, opacity: 0.7 }} /> : null}
          </React.Fragment>
        );
      })}
    </nav>
  );
}
