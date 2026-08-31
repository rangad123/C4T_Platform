import React from "react";
import { Logo } from "../core/Logo.jsx";
import { Button } from "../core/Button.jsx";
import { Icon } from "../core/Icon.jsx";
import { IconButton } from "../core/IconButton.jsx";

export const DEFAULT_NAV = [
  {
    label: "Platform",
    columns: [
      { title: "Test execution", links: [
        { icon: "bot", label: "AI test agents", desc: "Autonomous exploration and regression runs" },
        { icon: "users", label: "Crowd test network", desc: "42,000 vetted testers in 96 countries" },
        { icon: "workflow", label: "Test orchestration", desc: "One queue for agents and humans" },
      ] },
      { title: "Evidence", links: [
        { icon: "line-chart", label: "Coverage analytics", desc: "Where risk actually lives" },
        { icon: "clipboard-check", label: "Human review layer", desc: "Judgment on every AI verdict" },
        { icon: "plug", label: "Integrations", desc: "Jira, GitHub, Azure DevOps, Slack" },
      ] },
    ],
    feature: { badge: "New", title: "Agent Evaluation Suite", desc: "Grade LLM behaviour against a human rubric.", cta: "See how it works" },
  },
  {
    label: "Solutions",
    columns: [
      { title: "By discipline", links: [
        { icon: "test-tube-diagonal", label: "Functional & regression", desc: "Release-gating suites on every build" },
        { icon: "sparkles", label: "AI product evaluation", desc: "Red-teaming, hallucination and tone checks" },
        { icon: "accessibility", label: "Accessibility (WCAG 2.2)", desc: "Audits with assistive-tech users" },
      ] },
      { title: "By outcome", links: [
        { icon: "gauge", label: "Performance & load", desc: "Find the ceiling before your users do" },
        { icon: "globe", label: "Localization", desc: "In-market testers, 38 languages" },
        { icon: "shield-check", label: "Security assurance", desc: "OWASP-aligned validation" },
      ] },
    ],
  },
  {
    label: "Industries",
    columns: [
      { title: "Regulated", links: [
        { icon: "landmark", label: "Financial services", desc: "SOC 2, PCI DSS, audit-ready evidence" },
        { icon: "heart-pulse", label: "Healthcare & life sciences", desc: "HIPAA-safe test data handling" },
        { icon: "building-2", label: "Public sector", desc: "Section 508 and WCAG conformance" },
      ] },
      { title: "High velocity", links: [
        { icon: "shopping-cart", label: "Retail & e-commerce", desc: "Peak-season readiness programmes" },
        { icon: "radio-tower", label: "Telecom & media", desc: "Device-matrix coverage at scale" },
        { icon: "cloud", label: "B2B SaaS", desc: "Continuous regression for weekly releases" },
      ] },
    ],
  },
  {
    label: "Services",
    columns: [
      { title: "Engagements", links: [
        { icon: "users-round", label: "Managed QE pods", desc: "A dedicated team, embedded in your sprints" },
        { icon: "flask-conical", label: "AI testing services", desc: "Model, agent and RAG evaluation" },
        { icon: "code", label: "Test automation build", desc: "Playwright, Appium, Cypress" },
        { icon: "compass", label: "QE advisory", desc: "Maturity assessment and roadmap" },
      ] },
    ],
  },
  {
    label: "Resources",
    columns: [
      { title: "Learn", links: [
        { icon: "newspaper", label: "Blog", desc: "Field notes from the QE frontline" },
        { icon: "book-open", label: "Guides & playbooks", desc: "Practical, download-free" },
        { icon: "circle-help", label: "FAQs", desc: "How engagements actually work" },
      ] },
      { title: "Proof", links: [
        { icon: "file-text", label: "Case studies", desc: "Measured before and after" },
        { icon: "quote", label: "Customer stories", desc: "In their words" },
        { icon: "video", label: "Webinars", desc: "Live and on demand" },
      ] },
    ],
  },
  { label: "Pricing", href: "#pricing" },
  {
    label: "Company",
    columns: [
      { title: "Crowd4Test", links: [
        { icon: "info", label: "About us", desc: "Why we pair agents with people" },
        { icon: "briefcase", label: "Careers", desc: "We're hiring across QE and ML" },
        { icon: "mail", label: "Contact", desc: "Talk to a quality engineer" },
      ] },
    ],
  },
];

export function TopNav({ items = DEFAULT_NAV, active, onNavigate, sticky = true, announcement, style, className }) {
  const [open, setOpen] = React.useState(null);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const go = (label) => (e) => { e.preventDefault(); setOpen(null); setMobileOpen(false); if (onNavigate) onNavigate(label); };

  return (
    <header
      className={className}
      onMouseLeave={() => setOpen(null)}
      style={{ position: sticky ? "sticky" : "relative", top: 0, zIndex: 50, background: "var(--surface-canvas)", borderBottom: "1px solid var(--border-subtle)", ...style }}
    >
      {announcement ? (
        <div style={{ background: "var(--surface-inverse)", color: "var(--text-inverse)", fontSize: "var(--type-body-sm-size)", textAlign: "center", padding: "9px 16px" }}>{announcement}</div>
      ) : null}
      <div style={{ maxWidth: "var(--container-wide)", margin: "0 auto", padding: "0 var(--container-gutter)", height: 72, display: "flex", alignItems: "center", gap: 32 }}>
        <Logo size={21} href="#" onClick={go("Home")} />
        <nav aria-label="Primary" style={{ display: "flex", alignItems: "center", gap: 2, marginRight: "auto" }} className="c4t-nav-desktop">
          {items.map((item) => (
            <a
              key={item.label}
              href={item.href || "#"}
              onClick={go(item.label)}
              onMouseEnter={() => setOpen(item.columns ? item.label : null)}
              className="c4t-navlink"
              aria-expanded={item.columns ? open === item.label : undefined}
              style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "8px 12px", borderRadius: "var(--radius-sm)", fontSize: "var(--type-body-sm-size)", fontWeight: "var(--fw-medium)", color: active === item.label || open === item.label ? "var(--text-primary)" : "var(--text-secondary)", textDecoration: "none", whiteSpace: "nowrap" }}
            >
              {item.label}
              {item.columns ? <Icon name="chevron-down" size={14} style={{ opacity: 0.6, transform: open === item.label ? "rotate(180deg)" : "none", transition: "transform var(--duration-fast) var(--ease-standard)" }} /> : null}
            </a>
          ))}
        </nav>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }} className="c4t-nav-desktop">
          <Button variant="ghost" size="sm" href="#" onClick={go("Sign in")}>Sign in</Button>
          <Button variant="primary" size="sm" href="#" onClick={go("Contact")}>Book a demo</Button>
        </div>
        <span className="c4t-nav-mobile" style={{ marginLeft: "auto" }}>
          <IconButton icon={mobileOpen ? "x" : "menu"} label="Menu" onClick={() => setMobileOpen(!mobileOpen)} />
        </span>
      </div>

      {open ? (() => {
        const item = items.find((i) => i.label === open);
        if (!item || !item.columns) return null;
        return (
          <div onMouseEnter={() => setOpen(open)} style={{ position: "absolute", left: 0, right: 0, background: "var(--surface-canvas)", borderTop: "1px solid var(--border-subtle)", borderBottom: "1px solid var(--border-default)", boxShadow: "var(--shadow-md)" }}>
            <div style={{ maxWidth: "var(--container-wide)", margin: "0 auto", padding: "28px var(--container-gutter) 32px", display: "grid", gridTemplateColumns: `repeat(${item.columns.length}, minmax(0,1fr))${item.feature ? " 320px" : ""}`, gap: 32 }}>
              {item.columns.map((col) => (
                <div key={col.title}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 12 }}>{col.title}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    {col.links.map((l) => (
                      <a key={l.label} href="#" onClick={go(l.label)} className="c4t-megalink" style={{ display: "flex", gap: 12, padding: "10px 12px", margin: "0 -12px", borderRadius: "var(--radius-sm)", textDecoration: "none", transition: "var(--transition-control)" }}>
                        <Icon name={l.icon} size={18} style={{ color: "var(--coral-500)", marginTop: 2 }} />
                        <span>
                          <span style={{ display: "block", fontSize: "var(--type-body-sm-size)", fontWeight: "var(--fw-medium)", color: "var(--text-primary)" }}>{l.label}</span>
                          <span style={{ display: "block", fontSize: "var(--type-caption-size)", color: "var(--text-muted)", marginTop: 2 }}>{l.desc}</span>
                        </span>
                      </a>
                    ))}
                  </div>
                </div>
              ))}
              {item.feature ? (
                <div style={{ background: "var(--surface-sunken)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-card)", padding: 20 }}>
                  <span style={{ display: "inline-flex", height: 22, alignItems: "center", padding: "0 8px", borderRadius: 999, background: "var(--surface-brand-subtle)", color: "var(--text-brand)", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" }}>{item.feature.badge}</span>
                  <div style={{ fontSize: "var(--type-heading-sm-size)", fontWeight: "var(--fw-semibold)", marginTop: 12, letterSpacing: "-0.1px" }}>{item.feature.title}</div>
                  <p style={{ fontSize: "var(--type-body-sm-size)", color: "var(--text-secondary)", marginTop: 6 }}>{item.feature.desc}</p>
                  <a href="#" onClick={go(item.feature.cta)} style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 14, fontSize: "var(--type-body-sm-size)", fontWeight: "var(--fw-medium)", color: "var(--text-brand)", textDecoration: "none" }}>
                    {item.feature.cta} <Icon name="arrow-right" size={15} />
                  </a>
                </div>
              ) : null}
            </div>
          </div>
        );
      })() : null}

      {mobileOpen ? (
        <div style={{ borderTop: "1px solid var(--border-subtle)", padding: "12px var(--container-gutter) 24px", display: "flex", flexDirection: "column", gap: 2, maxHeight: "70vh", overflowY: "auto" }}>
          {items.map((item) => (
            <a key={item.label} href="#" onClick={go(item.label)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "13px 0", borderBottom: "1px solid var(--border-subtle)", fontSize: "var(--type-body-md-size)", fontWeight: "var(--fw-medium)", color: "var(--text-primary)", textDecoration: "none" }}>
              {item.label}{item.columns ? <Icon name="chevron-right" size={16} style={{ color: "var(--text-muted)" }} /> : null}
            </a>
          ))}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
            <Button variant="primary" fullWidth href="#" onClick={go("Contact")}>Book a demo</Button>
            <Button variant="secondary" fullWidth href="#" onClick={go("Sign in")}>Sign in</Button>
          </div>
        </div>
      ) : null}
    </header>
  );
}
