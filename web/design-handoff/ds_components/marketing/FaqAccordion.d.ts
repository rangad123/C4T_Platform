export interface FaqItem { q: string; a: React.ReactNode }
export interface FaqAccordionProps {
  items?: FaqItem[];
  /** Index open on mount; -1 for all closed. */
  defaultOpen?: number;
  style?: React.CSSProperties;
  className?: string;
}
export declare function FaqAccordion(props: FaqAccordionProps): JSX.Element;
