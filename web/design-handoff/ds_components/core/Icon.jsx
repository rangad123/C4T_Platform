import React from "react";

const LUCIDE_CDN = "https://unpkg.com/lucide-static@0.544.0/icons";

/**
 * Renders a Lucide icon as a masked block so it inherits `currentColor`.
 * Crowd4Test uses Lucide at 2px stroke for all UI iconography.
 */
export function Icon({ name, size = 20, strokeWidth, color = "currentColor", style, className, label }) {
  const url = `${LUCIDE_CDN}/${name}.svg`;
  const mask = { WebkitMaskImage: `url(${url})`, maskImage: `url(${url})`, WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat", WebkitMaskPosition: "center", maskPosition: "center", WebkitMaskSize: "contain", maskSize: "contain" };
  return (
    <span
      className={className}
      role={label ? "img" : "presentation"}
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
      data-stroke={strokeWidth}
      style={{ display: "inline-block", flex: "none", width: size, height: size, background: color, verticalAlign: "middle", ...mask, ...style }}
    />
  );
}
