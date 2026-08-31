export interface LogoCloudProps {
  /** Company names — rendered as wordmark placeholders until real SVGs exist. */
  logos?: string[];
  label?: string;
  tone?: "canvas" | "inverse";
  style?: React.CSSProperties;
  className?: string;
}
export declare function LogoCloud(props: LogoCloudProps): JSX.Element;
