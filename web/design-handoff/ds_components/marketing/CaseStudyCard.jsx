import React from "react";
import { Icon } from "../core/Icon.jsx";
import { Media } from "./Media.jsx";

export function CaseStudyCard({ client, industry, headline, results = [], featured, href, onClick, style, className }) {
  if (featured) {
    return (
      <a href={href || "#"} onClick={onClick} className={["c4t-card-hover", "c4t-casestudy-featured", className].filter(Boolean).join(" ")}
        style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 0, overflow: "hidden", background: "var(--surface-canvas)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-panel)", textDecoration: "none", color: "inherit", ...style }}>
        <div style={{ padding: 40, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-muted)" }}>
            <span style={{ color: "var(--text-brand)" }}>Case study</span>{industry}
          </div>
          <h3 style={{ marginTop: 16, fontSize: "var(--type-heading-lg-size)", lineHeight: "var(--type-heading-lg-line)", letterSpacing: "var(--type-heading-lg-tracking)", textWrap: "pretty" }}>{headline}</h3>
          <div style={{ marginTop: 28, display: "grid", gridTemplateColumns: `repeat(${Math.min(results.length, 3) || 1}, 1fr)`, gap: 20 }}>
            {results.map((r) => (
              <div key={r.label}>
                <div style={{ fontSize: 32, fontWeight: "var(--fw-semibold)", letterSpacing: "-1px", fontVariantNumeric: "tabular-nums", color: "var(--text-primary)" }}>{r.value}</div>
                <div style={{ marginTop: 4, fontSize: "var(--type-caption-size)", color: "var(--text-muted)" }}>{r.label}</div>
              </div>
            ))}
          </div>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: "auto", paddingTop: 32, fontSize: "var(--type-body-sm-size)", fontWeight: "var(--fw-medium)", color: "var(--text-brand)" }}>
            Read the {client} story <Icon name="arrow-right" size={15} />
          </span>
        </div>
        <Media ratio="auto" label={client} icon="building-2" tone="sunken" radius="0" style={{ height: "100%", aspectRatio: "auto", borderWidth: 0, borderLeft: "1px solid var(--border-subtle)" }} />
      </a>
    );
  }
  return (
    <a href={href || "#"} onClick={onClick} className={["c4t-card-hover", className].filter(Boolean).join(" ")}
      style={{ display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--surface-canvas)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-card)", textDecoration: "none", color: "inherit", height: "100%", ...style }}>
      <Media ratio="16 / 9" label={client} icon="building-2" tone="sunken" radius="0" style={{ borderWidth: 0, borderBottom: "1px solid var(--border-subtle)" }} />
      <div style={{ padding: "var(--space-card-padding)", display: "flex", flexDirection: "column", flex: 1 }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)" }}>{industry}</div>
        <h3 style={{ marginTop: 10, fontSize: "var(--type-heading-sm-size)", lineHeight: 1.35, letterSpacing: "-0.1px", textWrap: "pretty" }}>{headline}</h3>
        {results.length ? (
          <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--border-subtle)", display: "flex", gap: 24 }}>
            {results.slice(0, 2).map((r) => (
              <div key={r.label}>
                <div style={{ fontSize: 22, fontWeight: "var(--fw-semibold)", letterSpacing: "-0.5px", fontVariantNumeric: "tabular-nums" }}>{r.value}</div>
                <div style={{ fontSize: "var(--type-caption-size)", color: "var(--text-muted)", marginTop: 2 }}>{r.label}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </a>
  );
}
