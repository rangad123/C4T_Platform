import React from "react";
import { Logo } from "../core/Logo.jsx";
import { Icon } from "../core/Icon.jsx";
import { Input } from "../forms/Input.jsx";
import { Button } from "../core/Button.jsx";

export const DEFAULT_FOOTER_COLUMNS = [
  { title: "Platform", links: ["AI test agents", "Crowd test network", "Test orchestration", "Coverage analytics", "Integrations"] },
  { title: "Solutions", links: ["Functional & regression", "AI product evaluation", "Accessibility", "Performance & load", "Localization", "Security assurance"] },
  { title: "Industries", links: ["Financial services", "Healthcare", "Retail & e-commerce", "Telecom & media", "B2B SaaS", "Public sector"] },
  { title: "Resources", links: ["Blog", "Case studies", "Customer stories", "Guides", "Webinars", "FAQs"] },
  { title: "Company", links: ["About us", "Careers", "Contact", "Trust & security", "Partners"] },
];

export function Footer({ columns = DEFAULT_FOOTER_COLUMNS, onNavigate, newsletter = true, style, className }) {
  const go = (label) => (e) => { e.preventDefault(); if (onNavigate) onNavigate(label); };
  return (
    <footer className={className} style={{ background: "var(--surface-inverse)", color: "var(--text-inverse)", ...style }}>
      <div style={{ maxWidth: "var(--container-wide)", margin: "0 auto", padding: "64px var(--container-gutter) 32px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(240px, 1fr) 3fr", gap: 48 }} className="c4t-footer-top">
          <div>
            <Logo size={22} tone="inverse" href="#" onClick={go("Home")} />
            <p style={{ marginTop: 16, maxWidth: 300, fontSize: "var(--type-body-sm-size)", color: "var(--text-inverse-muted)" }}>
              Digital quality engineering that pairs AI agents with a vetted global testing community.
            </p>
            {newsletter ? (
              <form onSubmit={(e) => e.preventDefault()} style={{ marginTop: 24, display: "flex", gap: 8, maxWidth: 340 }}>
                <Input type="email" placeholder="Work email" aria-label="Work email" style={{ background: "var(--surface-inverse-raised)", border: "1px solid var(--border-inverse)", color: "var(--text-inverse)", minHeight: 44 }} />
                <Button type="submit" variant="inverse" size="md">Subscribe</Button>
              </form>
            ) : null}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 32 }}>
            {columns.map((col) => (
              <div key={col.title}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-inverse-muted)", marginBottom: 14 }}>{col.title}</div>
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                  {col.links.map((l) => (
                    <li key={l}>
                      <a href="#" onClick={go(l)} className="c4t-inverse-link" style={{ fontSize: "var(--type-body-sm-size)", color: "var(--text-inverse-muted)", textDecoration: "none" }}>{l}</a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <div style={{ marginTop: 48, paddingTop: 24, borderTop: "1px solid var(--border-inverse)", display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 20, fontSize: "var(--type-caption-size)", color: "var(--text-inverse-muted)" }}>
            <span>© 2026 Crowd4Test Ltd.</span>
            <a href="#" onClick={go("Privacy")} className="c4t-inverse-link" style={{ color: "inherit", textDecoration: "none" }}>Privacy</a>
            <a href="#" onClick={go("Terms")} className="c4t-inverse-link" style={{ color: "inherit", textDecoration: "none" }}>Terms</a>
            <a href="#" onClick={go("Accessibility")} className="c4t-inverse-link" style={{ color: "inherit", textDecoration: "none" }}>Accessibility statement</a>
            <span style={{ fontFamily: "var(--font-mono)" }}>SOC 2 Type II · ISO 27001</span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {["linkedin", "github", "youtube", "rss"].map((n) => (
              <a key={n} href="#" onClick={go(n)} aria-label={n} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: "var(--radius-sm)", border: "1px solid var(--border-inverse)", color: "var(--text-inverse-muted)" }}>
                <Icon name={n} size={16} />
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
