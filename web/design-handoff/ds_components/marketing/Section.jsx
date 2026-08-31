import React from "react";

const TONES = {
  canvas: { background: "var(--surface-canvas)", color: "var(--text-primary)" },
  sunken: { background: "var(--surface-sunken)", color: "var(--text-primary)" },
  inverse: { background: "var(--surface-inverse)", color: "var(--text-inverse)" },
  brand: { background: "var(--surface-brand-subtle)", color: "var(--text-primary)" },
};

export function Section({ tone = "canvas", compact, divider, id, children, style, className }) {
  return (
    <section
      id={id}
      className={className}
      style={{ paddingBlock: compact ? "var(--space-section-y-compact)" : "var(--space-section-y)", borderTop: divider ? "1px solid var(--border-subtle)" : undefined, ...TONES[tone], ...style }}
    >
      <div style={{ maxWidth: "var(--container-max)", margin: "0 auto", paddingInline: "var(--container-gutter)" }}>{children}</div>
    </section>
  );
}
