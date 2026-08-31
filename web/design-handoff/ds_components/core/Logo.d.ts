export interface LogoProps {
  /** Cap height in px. 22 in nav, 20 in footer, 40+ in hero lockups. */
  size?: number;
  tone?: "default" | "inverse";
  /** Link target; pass null/"" to render a plain span. */
  href?: string;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Logo(props: LogoProps): JSX.Element;
