import React from "react";
import { Icon } from "./Icon.jsx";

const SIZES = { sm: 32, md: 40, lg: 48 };

export function IconButton({ icon, label, size = "md", variant = "ghost", disabled, onClick, href, style, className, ...rest }) {
  const box = SIZES[size] || SIZES.md;
  const surfaces = {
    ghost: { background: "transparent", border: "1px solid transparent" },
    outline: { background: "var(--surface-canvas)", border: "1px solid var(--border-default)" },
    filled: { background: "var(--surface-sunken)", border: "1px solid transparent" },
  };
  const Tag = href ? "a" : "button";
  return (
    <Tag
      className={["c4t-iconbtn", className].filter(Boolean).join(" ")}
      href={href}
      type={href ? undefined : "button"}
      aria-label={label}
      disabled={href ? undefined : disabled}
      onClick={onClick}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: box, height: box, borderRadius: "var(--radius-sm)", color: "var(--text-secondary)", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, transition: "var(--transition-control)", ...surfaces[variant], ...style }}
      {...rest}
    >
      <Icon name={icon} size={size === "sm" ? 16 : size === "lg" ? 22 : 18} />
    </Tag>
  );
}
