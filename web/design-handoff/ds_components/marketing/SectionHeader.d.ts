export interface SectionHeaderProps {
  /** Mono uppercase kicker. */
  eyebrow?: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  align?: "left" | "center";
  tone?: "default" | "inverse";
  /** Buttons or links rendered under the copy. */
  actions?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}
export declare function SectionHeader(props: SectionHeaderProps): JSX.Element;
