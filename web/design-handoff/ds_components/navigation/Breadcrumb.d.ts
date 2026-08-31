export interface BreadcrumbProps {
  /** Ordered trail; the last entry renders as the current page. */
  items?: (string | { label: string; href?: string })[];
  /** inverse on dark hero bands. */
  tone?: "default" | "inverse";
  onNavigate?: (label: string) => void;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Breadcrumb(props: BreadcrumbProps): JSX.Element;
