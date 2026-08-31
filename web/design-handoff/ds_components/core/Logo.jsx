import React from "react";

/**
 * No logo files were supplied with the brief, so the brand mark is the wordmark
 * set in the display face with the "4" in coral. Replace with real artwork when available.
 */
export function Logo({ size = 22, tone = "default", href = "/", style, className }) {
  const color = tone === "inverse" ? "var(--text-inverse)" : "var(--text-primary)";
  const accent = tone === "inverse" ? "var(--coral-400)" : "var(--coral-500)";
  const Tag = href ? "a" : "span";
  return (
    <Tag
      className={className}
      href={href}
      aria-label="Crowd4Test"
      style={{ display: "inline-flex", alignItems: "center", fontFamily: "var(--font-display)", fontWeight: "var(--fw-semibold)", fontSize: size, letterSpacing: size * -0.038, lineHeight: 1, color, textDecoration: "none", ...style }}
    >
      Crowd<span style={{ color: accent }}>4</span>Test
    </Tag>
  );
}
