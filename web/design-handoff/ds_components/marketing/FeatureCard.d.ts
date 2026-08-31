export interface FeatureCardProps {
  /** Lucide icon name, shown in a coral tile. */
  icon?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Mono footnote under a hairline — metrics, coverage counts. */
  meta?: React.ReactNode;
  href?: string;
  onClick?: (e: React.MouseEvent) => void;
  tone?: "canvas" | "inverse";
  style?: React.CSSProperties;
  className?: string;
}
export declare function FeatureCard(props: FeatureCardProps): JSX.Element;
