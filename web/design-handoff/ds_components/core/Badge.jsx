import React from "react";
import { Icon } from "./Icon.jsx";

const TONES = {
  neutral: { background: "var(--surface-muted)", color: "var(--text-secondary)" },
  brand: { background: "var(--surface-brand-subtle)", color: "var(--text-brand)" },
  accent: { background: "var(--surface-accent-subtle)", color: "var(--text-accent)" },
  success: { background: "var(--status-success-bg)", color: "var(--status-success-fg)" },
  warning: { background: "var(--status-warning-bg)", color: "var(--status-warning-fg)" },
  error: { background: "var(--status-error-bg)", color: "var(--status-error-fg)" },
  info: { background: "var(--status-info-bg)", color: "var(--status-info-fg)" },
  inverse: { background: "rgb(255 255 255 / 0.1)", color: "var(--text-inverse)" },
};

export function Badge({ children, tone = "neutral", icon, dot, uppercase = true, style, className }) {
  const t = TONES[tone] || TONES.neutral;
  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 24, padding: "0 10px", borderRadius: "var(--radius-full)", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: "var(--fw-semibold)", letterSpacing: uppercase ? "0.08em" : 0, textTransform: uppercase ? "uppercase" : "none", whiteSpace: "nowrap", ...t, ...style }}
    >
      {dot ? <span style={{ width: 6, height: 6, borderRadius: 999, background: "currentColor" }} /> : null}
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}
