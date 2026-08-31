export interface IndustryCardProps {
  /** Lucide icon used in the media plate. */
  icon?: string;
  name: string;
  description?: string;
  /** Headline proof point, e.g. "-63%". */
  stat?: string;
  statLabel?: string;
  href?: string;
  onClick?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
  className?: string;
}
export declare function IndustryCard(props: IndustryCardProps): JSX.Element;
