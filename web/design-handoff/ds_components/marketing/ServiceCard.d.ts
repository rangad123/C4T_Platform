export interface ServiceCardProps {
  icon?: string;
  /** Mono kicker above the title. */
  eyebrow?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Checklist of inclusions. */
  points?: string[];
  cta?: string;
  badge?: string;
  href?: string;
  onClick?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
  className?: string;
}
export declare function ServiceCard(props: ServiceCardProps): JSX.Element;
