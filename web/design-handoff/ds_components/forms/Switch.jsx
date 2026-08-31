import React from "react";

export function Switch({ label, checked, onChange, disabled, id, style, className }) {
  return (
    <label className={className} style={{ display: "inline-flex", gap: 10, alignItems: "center", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1, ...style }}>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={!!checked}
        disabled={disabled}
        onClick={onChange}
        style={{ width: 44, height: 26, flex: "none", padding: 3, borderRadius: 999, border: "none", background: checked ? "var(--coral-500)" : "var(--ink-300)", cursor: "inherit", transition: "var(--transition-control)" }}
      >
        <span style={{ display: "block", width: 20, height: 20, borderRadius: 999, background: "var(--white)", boxShadow: "var(--shadow-xs)", transform: `translateX(${checked ? 18 : 0}px)`, transition: `transform var(--duration-fast) var(--ease-standard)` }} />
      </button>
      {label ? <span style={{ fontSize: "var(--type-body-sm-size)", color: "var(--text-primary)" }}>{label}</span> : null}
    </label>
  );
}
