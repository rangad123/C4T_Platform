import React from "react";

export function StatBlock({ stats = [], tone = "canvas", columns, divided = true, align = "left", style, className }) {
  const inverse = tone === "inverse";
  const cols = columns || Math.min(stats.length, 4) || 1;
  return (
    <div
      className={["c4t-stat-grid", className].filter(Boolean).join(" ")}
      style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))`, gap: divided ? 0 : 32, textAlign: align, ...style }}
    >
      {stats.map((s, i) => (
        <div key={s.label} style={{ padding: divided ? "8px 32px" : 0, borderLeft: divided && i > 0 ? `1px solid ${inverse ? "var(--border-inverse)" : "var(--border-default)"}` : "none", paddingLeft: divided && i === 0 ? 0 : undefined }}>
          <div style={{ fontSize: "var(--type-metric-size)", lineHeight: "var(--type-metric-line)", letterSpacing: "var(--type-metric-tracking)", fontWeight: "var(--fw-semibold)", fontVariantNumeric: "tabular-nums", color: inverse ? "var(--text-inverse)" : "var(--text-primary)" }} className="c4t-stat-value">
            {s.value}
          </div>
          <div style={{ marginTop: 10, fontSize: "var(--type-body-sm-size)", fontWeight: "var(--fw-medium)", color: inverse ? "var(--text-inverse)" : "var(--text-primary)" }}>{s.label}</div>
          {s.detail ? <div style={{ marginTop: 4, fontSize: "var(--type-caption-size)", color: inverse ? "var(--text-inverse-muted)" : "var(--text-muted)" }}>{s.detail}</div> : null}
        </div>
      ))}
    </div>
  );
}
