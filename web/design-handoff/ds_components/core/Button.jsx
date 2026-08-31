import React from "react";
import { Icon } from "./Icon.jsx";

const SIZES = {
  sm: { height: 36, padding: "0 14px", fontSize: "var(--type-button-sm-size)", icon: 16, gap: 6 },
  md: { height: 44, padding: "0 20px", fontSize: "var(--type-button-md-size)", icon: 18, gap: 8 },
  lg: { height: 52, padding: "0 26px", fontSize: "var(--type-button-lg-size)", icon: 20, gap: 8 },
};

const VARIANTS = {
  primary: { background: "var(--action-primary-bg)", color: "var(--text-on-brand)", border: "1px solid transparent" },
  secondary: { background: "var(--action-secondary-bg)", color: "var(--text-primary)", border: "1px solid var(--action-secondary-border)" },
  ghost: { background: "transparent", color: "var(--text-primary)", border: "1px solid transparent" },
  link: { background: "transparent", color: "var(--text-brand)", border: "1px solid transparent", padding: 0, height: "auto" },
  inverse: { background: "var(--action-inverse-bg)", color: "var(--action-inverse-text)", border: "1px solid transparent" },
  "inverse-ghost": { background: "transparent", color: "var(--text-inverse)", border: "1px solid var(--border-inverse)" },
};

export function Button({ children, variant = "primary", size = "md", iconLeft, iconRight, fullWidth, disabled, href, type = "button", onClick, className, style, ...rest }) {
  const s = SIZES[size] || SIZES.md;
  const v = VARIANTS[variant] || VARIANTS.primary;
  const Tag = href ? "a" : "button";
  const base = {
    display: fullWidth ? "flex" : "inline-flex",
    width: fullWidth ? "100%" : undefined,
    alignItems: "center",
    justifyContent: "center",
    gap: s.gap,
    height: s.height,
    padding: s.padding,
    fontFamily: "var(--font-sans)",
    fontSize: s.fontSize,
    fontWeight: "var(--fw-medium)",
    lineHeight: 1,
    letterSpacing: "-0.1px",
    borderRadius: "var(--radius-button)",
    cursor: disabled ? "not-allowed" : "pointer",
    textDecoration: variant === "link" ? "underline" : "none",
    textUnderlineOffset: 4,
    whiteSpace: "nowrap",
    transition: "var(--transition-control)",
    opacity: disabled ? 0.55 : 1,
    ...v,
    ...style,
  };
  return (
    <Tag
      className={["c4t-btn", `c4t-btn--${variant}`, className].filter(Boolean).join(" ")}
      href={href}
      type={href ? undefined : type}
      disabled={href ? undefined : disabled}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      style={base}
      {...rest}
    >
      {iconLeft ? <Icon name={iconLeft} size={s.icon} /> : null}
      {children}
      {iconRight ? <Icon name={iconRight} size={s.icon} /> : null}
    </Tag>
  );
}
