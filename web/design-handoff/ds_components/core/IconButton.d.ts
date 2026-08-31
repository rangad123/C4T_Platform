export interface IconButtonProps {
  /** Lucide icon name. */
  icon: string;
  /** Required accessible label — icon-only controls must be named. */
  label: string;
  size?: "sm" | "md" | "lg";
  variant?: "ghost" | "outline" | "filled";
  disabled?: boolean;
  href?: string;
  onClick?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
  className?: string;
}
export declare function IconButton(props: IconButtonProps): JSX.Element;
