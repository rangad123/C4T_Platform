import React from "react";
import { Icon } from "../core/Icon.jsx";

export function FaqAccordion({ items = [], defaultOpen = 0, style, className }) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className={className} style={{ borderTop: "1px solid var(--border-default)", ...style }}>
      {items.map((item, i) => {
        const on = open === i;
        return (
          <div key={item.q} style={{ borderBottom: "1px solid var(--border-default)" }}>
            <button
              type="button"
              className="c4t-faq-trigger"
              aria-expanded={on}
              onClick={() => setOpen(on ? -1 : i)}
              style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24, padding: "22px 12px 22px 0", background: "transparent", border: "none", textAlign: "left", cursor: "pointer", fontSize: "var(--type-heading-sm-size)", fontWeight: "var(--fw-medium)", letterSpacing: "-0.1px", color: "var(--text-primary)", transition: "var(--transition-control)" }}
            >
              {item.q}
              <Icon name={on ? "minus" : "plus"} size={20} style={{ color: "var(--text-muted)", flex: "none" }} />
            </button>
            {on ? (
              <div style={{ padding: "0 60px 24px 0", fontSize: "var(--type-body-md-size)", lineHeight: 1.65, color: "var(--text-secondary)", maxWidth: 760 }}>{item.a}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
