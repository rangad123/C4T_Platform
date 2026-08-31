import React from "react";
import { Icon } from "../core/Icon.jsx";

export function Pagination({ page = 1, pageCount = 1, onChange, style, className }) {
  const pages = [];
  for (let i = 1; i <= pageCount; i++) {
    if (i === 1 || i === pageCount || Math.abs(i - page) <= 1) pages.push(i);
    else if (pages[pages.length - 1] !== "…") pages.push("…");
  }
  const cell = { minWidth: 40, height: 40, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 10px", borderRadius: "var(--radius-sm)", border: "1px solid transparent", background: "transparent", fontSize: "var(--type-body-sm-size)", fontWeight: "var(--fw-medium)", color: "var(--text-secondary)", cursor: "pointer", transition: "var(--transition-control)" };
  return (
    <nav aria-label="Pagination" className={className} style={{ display: "flex", alignItems: "center", gap: 4, ...style }}>
      <button type="button" className="c4t-page-btn" style={cell} disabled={page === 1} onClick={() => onChange && onChange(page - 1)} aria-label="Previous page">
        <Icon name="chevron-left" size={16} />
      </button>
      {pages.map((p, i) =>
        p === "…" ? (
          <span key={`gap${i}`} style={{ ...cell, cursor: "default", color: "var(--text-disabled)" }}>…</span>
        ) : (
          <button key={p} type="button" className="c4t-page-btn" aria-current={p === page ? "page" : undefined} onClick={() => onChange && onChange(p)}
            style={{ ...cell, background: p === page ? "var(--ink-950)" : "transparent", color: p === page ? "var(--text-inverse)" : cell.color }}>
            {p}
          </button>
        )
      )}
      <button type="button" className="c4t-page-btn" style={cell} disabled={page === pageCount} onClick={() => onChange && onChange(page + 1)} aria-label="Next page">
        <Icon name="chevron-right" size={16} />
      </button>
    </nav>
  );
}
