import React from "react";

export function Tag({ children, active, href, onClick, style, className }) {
  const Tag_ = href ? "a" : onClick ? "button" : "span";
  return (
    <Tag_
      className={className}
      href={href}
      type={onClick && !href ? "button" : undefined}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 32,
        padding: "0 14px",
        borderRadius: "var(--radius-full)",
        border: `1px solid ${active ? "var(--ink-950)" : "var(--border-default)"}`,
        background: active ? "var(--ink-950)" : "var(--surface-canvas)",
        color: active ? "var(--text-inverse)" : "var(--text-secondary)",
        fontSize: "var(--type-body-sm-size)",
        fontWeight: "var(--fw-medium)",
        lineHeight: 1,
        textDecoration: "none",
        cursor: href || onClick ? "pointer" : "default",
        transition: "var(--transition-control)",
        ...style,
      }}
    >
      {children}
    </Tag_>
  );
}
