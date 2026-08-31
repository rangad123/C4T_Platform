import React from "react";
import { Icon } from "../core/Icon.jsx";
import { Button } from "../core/Button.jsx";
import { Badge } from "../core/Badge.jsx";

export function PricingTable({ plans = [], note, onSelect, style, className }) {
  return (
    <div className={["c4t-pricing-grid", className].filter(Boolean).join(" ")} style={{ display: "grid", gridTemplateColumns: `repeat(${plans.length || 1}, minmax(0,1fr))`, gap: 20, alignItems: "stretch", ...style }}>
      {plans.map((plan) => {
        const hot = plan.highlighted;
        return (
          <div
            key={plan.name}
            style={{
              display: "flex",
              flexDirection: "column",
              padding: "var(--space-card-padding-lg)",
              background: hot ? "var(--surface-inverse)" : "var(--surface-canvas)",
              color: hot ? "var(--text-inverse)" : "var(--text-primary)",
              border: `1px solid ${hot ? "var(--surface-inverse)" : "var(--border-default)"}`,
              borderRadius: "var(--radius-panel)",
              boxShadow: hot ? "var(--shadow-lg)" : "none",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 26 }}>
              <span style={{ fontSize: "var(--type-heading-sm-size)", fontWeight: "var(--fw-semibold)" }}>{plan.name}</span>
              {plan.badge ? <Badge tone={hot ? "inverse" : "brand"}>{plan.badge}</Badge> : null}
            </div>
            <p style={{ marginTop: 8, fontSize: "var(--type-body-sm-size)", color: hot ? "var(--text-inverse-muted)" : "var(--text-secondary)", minHeight: 44 }}>{plan.description}</p>
            <div style={{ marginTop: 20, display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontSize: 40, fontWeight: "var(--fw-semibold)", letterSpacing: "-1.6px", fontVariantNumeric: "tabular-nums" }}>{plan.price}</span>
              {plan.period ? <span style={{ fontSize: "var(--type-body-sm-size)", color: hot ? "var(--text-inverse-muted)" : "var(--text-muted)" }}>{plan.period}</span> : null}
            </div>
            <div style={{ marginTop: 24 }}>
              <Button variant={hot ? "inverse" : "secondary"} fullWidth onClick={() => onSelect && onSelect(plan.name)}>{plan.cta || "Talk to sales"}</Button>
            </div>
            {plan.featuresLabel ? (
              <div style={{ marginTop: 24, fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: hot ? "var(--text-inverse-muted)" : "var(--text-muted)" }}>{plan.featuresLabel}</div>
            ) : null}
            <ul style={{ listStyle: "none", margin: "14px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
              {(plan.features || []).map((f) => (
                <li key={f} style={{ display: "flex", gap: 10, fontSize: "var(--type-body-sm-size)", lineHeight: 1.5, color: hot ? "var(--text-inverse-muted)" : "var(--text-secondary)" }}>
                  <Icon name="check" size={16} style={{ color: hot ? "var(--coral-400)" : "var(--teal-500)", marginTop: 3, flex: "none" }} />{f}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {note ? <p style={{ gridColumn: "1 / -1", marginTop: 8, fontSize: "var(--type-caption-size)", color: "var(--text-muted)", textAlign: "center" }}>{note}</p> : null}
    </div>
  );
}
