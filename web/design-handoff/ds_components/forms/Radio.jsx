import React from "react";

export function Radio({ label, description, name, value, checked, onChange, disabled, id, style, className }) {
  return (
    <label className={className} style={{ display: "flex", gap: 10, alignItems: description ? "flex-start" : "center", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1, ...style }}>
      <span style={{ position: "relative", display: "inline-flex", flex: "none", marginTop: description ? 2 : 0 }}>
        <input type="radio" id={id} name={name} value={value} checked={checked} onChange={onChange} disabled={disabled}
          style={{ appearance: "none", margin: 0, width: 20, height: 20, borderRadius: 999, border: `${checked ? 6 : 1}px solid ${checked ? "var(--coral-500)" : "var(--border-strong)"}`, background: "var(--surface-canvas)", cursor: "inherit", transition: "var(--transition-control)" }} />
      </span>
      <span>
        <span style={{ display: "block", fontSize: "var(--type-body-sm-size)", lineHeight: 1.45, color: "var(--text-primary)" }}>{label}</span>
        {description ? <span style={{ display: "block", fontSize: "var(--type-caption-size)", color: "var(--text-muted)", marginTop: 2 }}>{description}</span> : null}
      </span>
    </label>
  );
}
