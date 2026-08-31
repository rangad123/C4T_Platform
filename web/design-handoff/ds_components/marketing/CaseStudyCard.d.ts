export interface CaseStudyResult { value: string; label: string }
export interface CaseStudyCardProps {
  client: string;
  industry?: string;
  headline: React.ReactNode;
  /** Up to 3 in featured layout, 2 in the grid card. */
  results?: CaseStudyResult[];
  /** Wide two-column layout for the top of the case studies index. */
  featured?: boolean;
  href?: string;
  onClick?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
  className?: string;
}
export declare function CaseStudyCard(props: CaseStudyCardProps): JSX.Element;
