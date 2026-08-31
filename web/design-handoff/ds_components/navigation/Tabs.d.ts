export interface TabsProps {
  /** Strings, or {value,label} pairs. */
  items?: (string | { value: string; label: string })[];
  value?: string;
  onChange?: (value: string) => void;
  /** underline = section navigation; pill = compact in-card switch. */
  variant?: "underline" | "pill";
  style?: React.CSSProperties;
  className?: string;
}
export declare function Tabs(props: TabsProps): JSX.Element;
