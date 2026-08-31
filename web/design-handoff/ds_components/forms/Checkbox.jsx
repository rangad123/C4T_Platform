import React from "react";
import { Icon } from "../core/Icon.jsx";

export function Checkbox({ label, description, checked, defaultChecked, onChange, disabled, id, style, className }) {
  return (
    <label className={className} style={{ display: "flex", gap: 10, alignItems: description ? "flex-start" : "center", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1, ...style }}>
      <span style={{ position: "relative", display: "inline-flex", flex: "none", marginTop: description ? 2 : 0 }}>
        <input type="checkbox" id={id} checked={checked} defaultChecked={defaultChecked} onChange={onChange} disabled={disabled}
          style={{ appearance: "none", margin: 0, width: 20, height: 20, borderRadius: "var(--radius-xs)", border: "1px solid var(--border-strong)", background: checked ? "var(--ink-950)" : "var(--surface-canvas)", cursor: "inherit", transition: "var(--transition-control)" }} />
        {checked ? <Icon name="check" size={14} style={{ position: "absolute", inset: 0, margin: "auto", color: "var(--white)", pointerEvents: "none" }} /> : null}
      </span>
      <span>
        <span style={{ display: "block", fontSize: "var(--type-body-sm-size)", lineHeight: 1.45, color: "var(--text-primary)" }}>{label}</span>
        {description ? <span style={{ display: "block", fontSize: "var(--type-caption-size)", color: "var(--text-muted)", marginTop: 2 }}>{description}</span> : null}
      </span>
    </label>
  );
}
