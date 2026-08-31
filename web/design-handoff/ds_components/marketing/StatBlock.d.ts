export interface Stat { value: string; label: string; detail?: string }
export interface StatBlockProps {
  stats?: Stat[];
  tone?: "canvas" | "inverse";
  /** Defaults to stats.length capped at 4. */
  columns?: number;
  /** Hairline rules between cells. Default true. */
  divided?: boolean;
  align?: "left" | "center";
  style?: React.CSSProperties;
  className?: string;
}
export declare function StatBlock(props: StatBlockProps): JSX.Element;
