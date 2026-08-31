export interface MediaProps {
  /** CSS aspect-ratio, e.g. "16 / 9". */
  ratio?: string;
  /** Placeholder caption. */
  label?: string;
  /** Lucide icon shown in the plate. */
  icon?: string;
  tone?: "sunken" | "brand" | "accent" | "inverse";
  radius?: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Media(props: MediaProps): JSX.Element;
