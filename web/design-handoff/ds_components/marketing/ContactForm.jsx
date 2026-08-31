import React from "react";
import { Field } from "../forms/Field.jsx";
import { Input } from "../forms/Input.jsx";
import { Textarea } from "../forms/Textarea.jsx";
import { Select } from "../forms/Select.jsx";
import { Checkbox } from "../forms/Checkbox.jsx";
import { Button } from "../core/Button.jsx";
import { Icon } from "../core/Icon.jsx";

export function ContactForm({ title = "Book a demo", description, submitLabel = "Request my demo", onSubmit, style, className }) {
  const [sent, setSent] = React.useState(false);
  const [consent, setConsent] = React.useState(false);
  const submit = (e) => {
    e.preventDefault();
    setSent(true);
    if (onSubmit) onSubmit(Object.fromEntries(new FormData(e.target).entries()));
  };
  if (sent) {
    return (
      <div className={className} style={{ padding: 40, background: "var(--surface-canvas)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-panel)", textAlign: "center", ...style }}>
        <Icon name="check-circle-2" size={40} style={{ color: "var(--teal-500)", margin: "0 auto 16px" }} />
        <h3 style={{ fontSize: "var(--type-heading-md-size)", letterSpacing: "-0.2px" }}>Thanks — we'll be in touch</h3>
        <p style={{ marginTop: 10, fontSize: "var(--type-body-sm-size)", color: "var(--text-secondary)" }}>A quality engineer will reply within one business day with times that suit your team.</p>
        <div style={{ marginTop: 20 }}><Button variant="secondary" onClick={() => setSent(false)}>Send another</Button></div>
      </div>
    );
  }
  return (
    <form className={className} onSubmit={submit} style={{ padding: 32, background: "var(--surface-canvas)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-panel)", boxShadow: "var(--shadow-sm)", display: "flex", flexDirection: "column", gap: 16, ...style }}>
      {title ? <h3 style={{ fontSize: "var(--type-heading-md-size)", letterSpacing: "var(--type-heading-md-tracking)" }}>{title}</h3> : null}
      {description ? <p style={{ fontSize: "var(--type-body-sm-size)", color: "var(--text-secondary)", marginTop: -8 }}>{description}</p> : null}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }} className="c4t-form-row">
        <Field label="First name" required htmlFor="fn"><Input id="fn" name="firstName" required /></Field>
        <Field label="Last name" required htmlFor="ln"><Input id="ln" name="lastName" required /></Field>
      </div>
      <Field label="Work email" required htmlFor="we"><Input id="we" name="email" type="email" placeholder="you@company.com" required /></Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }} className="c4t-form-row">
        <Field label="Company" required htmlFor="co"><Input id="co" name="company" required /></Field>
        <Field label="Team size" htmlFor="ts"><Select id="ts" name="size" placeholder="Select" options={["1–50", "51–500", "501–5,000", "5,000+"]} /></Field>
      </div>
      <Field label="What do you need tested?" htmlFor="msg" hint="A sentence is plenty — we'll take it from there."><Textarea id="msg" name="message" rows={4} /></Field>
      <Checkbox label="Email me the quarterly QE benchmark report." checked={consent} onChange={() => setConsent(!consent)} />
      <Button type="submit" size="lg" fullWidth>{submitLabel}</Button>
      <p style={{ fontSize: "var(--type-caption-size)", color: "var(--text-muted)", textAlign: "center" }}>We reply within one business day. No sales sequence.</p>
    </form>
  );
}
