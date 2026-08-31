import React from "react";
import { Icon } from "../core/Icon.jsx";
import { controlBase } from "./Input.jsx";

export function Select({ options = [], invalid, placeholder, style, className, ...rest }) {
  return (
    <span style={{ position: "relative", display: "block" }}>
      <select
        className={["c4t-input", className].filter(Boolean).join(" ")}
        aria-invalid={invalid || undefined}
        style={{ ...controlBase, appearance: "none", paddingRight: 40, cursor: "pointer", ...style }}
        {...rest}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((o) => {
          const value = typeof o === "string" ? o : o.value;
          const label = typeof o === "string" ? o : o.label;
          return <option key={value} value={value}>{label}</option>;
        })}
      </select>
      <Icon name="chevron-down" size={18} style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)", pointerEvents: "none" }} />
    </span>
  );
}
