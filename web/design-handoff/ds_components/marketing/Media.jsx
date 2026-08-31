import React from "react";
import { Icon } from "../core/Icon.jsx";

/**
 * Photography placeholder. No image library shipped with the brief — every
 * marketing surface uses this plate so real assets can be dropped in later.
 */
export function Media({ ratio = "16 / 9", label = "Image", icon = "image", tone = "sunken", radius = "var(--radius-media)", style, className, children }) {
  const tones = {
    sunken: { background: "var(--surface-sunken)", color: "var(--text-disabled)", border: "1px solid var(--border-subtle)" },
    brand: { background: "var(--surface-brand-subtle)", color: "var(--coral-400)", border: "1px solid var(--coral-100)" },
    accent: { background: "var(--surface-accent-subtle)", color: "var(--teal-500)", border: "1px solid var(--teal-100)" },
    inverse: { background: "var(--surface-inverse-raised)", color: "var(--text-inverse-muted)", border: "1px solid var(--border-inverse)" },
  };
  return (
    <div className={className} style={{ position: "relative", aspectRatio: ratio, width: "100%", borderRadius: radius, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, ...tones[tone], ...style }}>
      {children || (
        <>
          <Icon name={icon} size={20} />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase" }}>{label}</span>
        </>
      )}
    </div>
  );
}
