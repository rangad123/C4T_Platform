import React from "react";
import { Icon } from "../core/Icon.jsx";
import { Media } from "./Media.jsx";

const TYPE_ICON = { Article: "newspaper", Guide: "book-open", Webinar: "video", Report: "file-text", "Case study": "trending-up", Podcast: "mic" };

export function ResourceCard({ type = "Article", title, description, readTime, date, author, layout = "vertical", href, onClick, style, className }) {
  const horizontal = layout === "horizontal";
  return (
    <a
      href={href || "#"}
      onClick={onClick}
      className={["c4t-card-hover", horizontal ? "c4t-resource-horizontal" : null, className].filter(Boolean).join(" ")}
      style={{ display: horizontal ? "grid" : "flex", gridTemplateColumns: horizontal ? "260px 1fr" : undefined, flexDirection: horizontal ? undefined : "column", gap: horizontal ? 24 : 0, overflow: "hidden", background: "var(--surface-canvas)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-card)", textDecoration: "none", color: "inherit", height: "100%", ...style }}
    >
      <Media ratio={horizontal ? "4 / 3" : "16 / 9"} label={type} icon={TYPE_ICON[type] || "file-text"} tone="sunken" radius="0" style={{ borderWidth: 0, borderRight: horizontal ? "1px solid var(--border-subtle)" : "none", borderBottom: horizontal ? "none" : "1px solid var(--border-subtle)", height: horizontal ? "100%" : undefined }} />
      <div style={{ padding: horizontal ? "20px 24px 20px 0" : "var(--space-card-padding)", display: "flex", flexDirection: "column", flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-brand)" }}>
          {type}
          {date ? <span style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>{date}</span> : null}
        </div>
        <h3 style={{ marginTop: 10, fontSize: "var(--type-heading-sm-size)", lineHeight: 1.35, letterSpacing: "var(--type-heading-sm-tracking)", textWrap: "pretty" }}>{title}</h3>
        {description ? <p style={{ marginTop: 8, fontSize: "var(--type-body-sm-size)", lineHeight: 1.55, color: "var(--text-secondary)" }}>{description}</p> : null}
        <div style={{ marginTop: "auto", paddingTop: 18, display: "flex", alignItems: "center", gap: 10, fontSize: "var(--type-caption-size)", color: "var(--text-muted)" }}>
          {author ? <span>{author}</span> : null}
          {author && readTime ? <span aria-hidden="true">·</span> : null}
          {readTime ? <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><Icon name="clock" size={13} />{readTime}</span> : null}
        </div>
      </div>
    </a>
  );
}
