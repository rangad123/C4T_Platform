/**
 * @startingPoint section="Marketing" subtitle="Full-width conversion band" viewport="1360x300"
 */
export interface CtaBannerProps {
  eyebrow?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  primaryCta?: string;
  secondaryCta?: string;
  /** Reassurance line under the buttons. */
  note?: string;
  tone?: "inverse" | "brand" | "sunken";
  onAction?: (label: string) => void;
  style?: React.CSSProperties;
  className?: string;
}
export declare function CtaBanner(props: CtaBannerProps): JSX.Element;
