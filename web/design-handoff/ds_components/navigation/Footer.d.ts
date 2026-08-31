export interface FooterColumn { title: string; links: string[] }
export interface FooterProps {
  /** Defaults to the five-column site map. */
  columns?: FooterColumn[];
  onNavigate?: (label: string) => void;
  /** Show the email capture in the brand column. Default true. */
  newsletter?: boolean;
  style?: React.CSSProperties;
  className?: string;
}
export declare const DEFAULT_FOOTER_COLUMNS: FooterColumn[];
export declare function Footer(props: FooterProps): JSX.Element;
