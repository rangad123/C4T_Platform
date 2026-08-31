import React from "react";
import { Icon } from "../core/Icon.jsx";
import { Media } from "./Media.jsx";

/**
 * The "AI + human" explainer band: a list of capabilities on one side, a
 * product plate on the other, with the active row driving what is shown.
 */
export function CapabilitySection({ eyebrow, title, description, capabilities = [], media, tone = "sunken", reverse, style, className }) {
  const [active, setActive] = React.useState(0);
  const inverse = tone === "inverse";
  const bg = inverse ? "var(--surface-inverse)" : tone === "sunken" ? "var(--surface-sunken)" : "var(--surface-canvas)";
  const fg = inverse ? "var(--text-inverse)" : "var(--text-primary)";
  const muted = inverse ? "var(--text-inverse-muted)" : "var(--text-secondary)";
  const current = capabilities[active] || {};
  return (
    <section className={className} style={{ background: bg, color: fg, paddingBlock: "var(--space-section-y)", ...style }}>
      <div style={{ maxWidth: "var(--container-max)", margin: "0 auto", paddingInline: "var(--container-gutter)" }}>
        <div style={{ maxWidth: 700 }}>
          {eyebrow ? <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--type-eyebrow-size)", fontWeight: 600, letterSpacing: "var(--type-eyebrow-tracking)", textTransform: "uppercase", color: inverse ? "var(--coral-400)" : "var(--text-brand)" }}>{eyebrow}</span> : null}
          <h2 style={{ marginTop: 14, fontSize: "var(--type-display-md-size)", lineHeight: "var(--type-display-md-line)", letterSpacing: "var(--type-display-md-tracking)", color: fg, textWrap: "balance" }}>{title}</h2>
          {description ? <p style={{ marginTop: 14, fontSize: "var(--type-body-lg-size)", color: muted }}>{description}</p> : null}
        </div>
        <div style={{ marginTop: 48, display: "grid", gridTemplateColumns: reverse ? "1.1fr 0.9fr" : "0.9fr 1.1fr", gap: 48, alignItems: "start", direction: reverse ? "rtl" : "ltr" }} className="c4t-capability-grid">
          <div style={{ direction: "ltr", display: "flex", flexDirection: "column" }}>
            {capabilities.map((c, i) => {
              const on = i === active;
              return (
                <button key={c.title} type="button" onClick={() => setActive(i)}
                  style={{ textAlign: "left", background: "transparent", border: "none", borderLeft: `2px solid ${on ? "var(--coral-500)" : inverse ? "var(--border-inverse)" : "var(--border-default)"}`, padding: "18px 0 18px 20px", cursor: "pointer", transition: "var(--transition-control)" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 10, fontSize: "var(--type-heading-sm-size)", fontWeight: "var(--fw-semibold)", letterSpacing: "-0.1px", color: on ? fg : inverse ? "var(--text-inverse-muted)" : "var(--text-muted)" }}>
                    {c.icon ? <Icon name={c.icon} size={18} style={{ color: on ? "var(--coral-500)" : "currentColor" }} /> : null}
                    {c.title}
                  </span>
                  {on && c.description ? <span style={{ display: "block", marginTop: 8, fontSize: "var(--type-body-sm-size)", lineHeight: 1.6, color: muted, maxWidth: 420 }}>{c.description}</span> : null}
                </button>
              );
            })}
          </div>
          <div style={{ direction: "ltr" }}>
            {media || <Media ratio="4 / 3" label={current.title || "Product view"} icon={current.icon || "monitor"} tone={inverse ? "inverse" : "sunken"} style={{ background: inverse ? undefined : "var(--surface-canvas)" }} />}
          </div>
        </div>
      </div>
    </section>
  );
}
