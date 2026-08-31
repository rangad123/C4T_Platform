export interface ResourceCardProps {
  /** Drives the placeholder icon: Article, Guide, Webinar, Report, Case study, Podcast. */
  type?: string;
  title: React.ReactNode;
  description?: string;
  readTime?: string;
  date?: string;
  author?: string;
  /** horizontal for the featured row at the top of an index. */
  layout?: "vertical" | "horizontal";
  href?: string;
  onClick?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
  className?: string;
}
export declare function ResourceCard(props: ResourceCardProps): JSX.Element;
