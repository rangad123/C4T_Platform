import React from "react";
import { controlBase } from "./Input.jsx";

export function Textarea({ rows = 5, invalid, style, className, ...rest }) {
  return (
    <textarea
      rows={rows}
      className={["c4t-input", className].filter(Boolean).join(" ")}
      aria-invalid={invalid || undefined}
      style={{ ...controlBase, resize: "vertical", ...style }}
      {...rest}
    />
  );
}
