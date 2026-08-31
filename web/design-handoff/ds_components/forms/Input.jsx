import React from "react";
import { Icon } from "../core/Icon.jsx";

export const controlBase = {
  width: "100%",
  minHeight: 48,
  padding: "12px 14px",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--type-body-md-size)",
  lineHeight: 1.4,
  color: "var(--text-primary)",
  background: "var(--surface-canvas)",
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius-input)",
  transition: "var(--transition-control)",
};

export function Input({ iconLeft, invalid, disabled, style, className, ...rest }) {
  const input = (
    <input
      className={["c4t-input", className].filter(Boolean).join(" ")}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      style={{ ...controlBase, paddingLeft: iconLeft ? 42 : 14, background: disabled ? "var(--surface-sunken)" : controlBase.background, color: disabled ? "var(--text-disabled)" : controlBase.color, ...style }}
      {...rest}
    />
  );
  if (!iconLeft) return input;
  return (
    <span style={{ position: "relative", display: "block" }}>
      <Icon name={iconLeft} size={18} style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)", pointerEvents: "none" }} />
      {input}
    </span>
  );
}
