export interface BadgeProps {
  children?: React.ReactNode;
  tone?: "neutral" | "brand" | "accent" | "success" | "warning" | "error" | "info" | "inverse";
  /** Lucide icon name rendered at 12px before the label. */
  icon?: string;
  /** Renders a 6px status dot before the label. */
  dot?: boolean;
  /** Default true — badges are uppercase mono. Set false for sentence-case labels. */
  uppercase?: boolean;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Badge(props: BadgeProps): JSX.Element;
