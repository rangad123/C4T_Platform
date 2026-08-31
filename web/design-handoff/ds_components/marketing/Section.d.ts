export interface SectionProps {
  tone?: "canvas" | "sunken" | "inverse" | "brand";
  /** 64px instead of 96px vertical rhythm. */
  compact?: boolean;
  /** Hairline rule on the top edge. */
  divider?: boolean;
  id?: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Section(props: SectionProps): JSX.Element;
