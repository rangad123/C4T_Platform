import React from "react";

export function Tabs({ items = [], value, onChange, variant = "underline", style, className }) {
  const isPill = variant === "pill";
  return (
    <div
      role="tablist"
      className={className}
      style={{ display: "flex", gap: isPill ? 6 : 24, borderBottom: isPill ? "none" : "1px solid var(--border-default)", background: isPill ? "var(--surface-sunken)" : "transparent", padding: isPill ? 4 : 0, borderRadius: isPill ? "var(--radius-full)" : 0, width: isPill ? "fit-content" : undefined, overflowX: "auto", ...style }}
    >
      {items.map((item) => {
        const key = typeof item === "string" ? item : item.value;
        const label = typeof item === "string" ? item : item.label;
        const on = value === key;
        return (
          <button
            key={key}
            role="tab"
            type="button"
            aria-selected={on}
            className="c4t-tab"
            onClick={() => onChange && onChange(key)}
            style={{
              border: "none",
              cursor: "pointer",
              whiteSpace: "nowrap",
              fontSize: "var(--type-body-sm-size)",
              fontWeight: "var(--fw-medium)",
              transition: "var(--transition-control)",
              ...(isPill
                ? { padding: "8px 16px", borderRadius: "var(--radius-full)", background: on ? "var(--surface-canvas)" : "transparent", color: on ? "var(--text-primary)" : "var(--text-muted)", boxShadow: on ? "var(--shadow-xs)" : "none" }
                : { padding: "0 0 12px", background: "transparent", color: on ? "var(--text-primary)" : "var(--text-muted)", borderBottom: `2px solid ${on ? "var(--coral-500)" : "transparent"}`, marginBottom: -1 }),
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
