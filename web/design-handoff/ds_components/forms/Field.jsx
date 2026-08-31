import React from "react";

export function Field({ label, hint, error, required, htmlFor, children, style, className }) {
  return (
    <div className={className} style={{ display: "flex", flexDirection: "column", gap: 6, ...style }}>
      {label ? (
        <label htmlFor={htmlFor} style={{ fontSize: "var(--type-label-size)", fontWeight: "var(--fw-medium)", color: "var(--text-primary)", lineHeight: "var(--type-label-line)" }}>
          {label}
          {required ? <span style={{ color: "var(--status-error-fg)", marginLeft: 3 }}>*</span> : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <span style={{ fontSize: "var(--type-caption-size)", color: "var(--status-error-fg)" }}>{error}</span>
      ) : hint ? (
        <span style={{ fontSize: "var(--type-caption-size)", color: "var(--text-muted)" }}>{hint}</span>
      ) : null}
    </div>
  );
}
