/**
 * @startingPoint section="Core" subtitle="Primary, secondary, ghost and inverse actions" viewport="700x220"
 */
export interface ButtonProps {
  children?: React.ReactNode;
  /** primary = coral CTA; secondary = outlined; ghost = bare; link = inline text; inverse* = on dark bands. */
  variant?: "primary" | "secondary" | "ghost" | "link" | "inverse" | "inverse-ghost";
  size?: "sm" | "md" | "lg";
  /** Lucide icon name rendered before the label. */
  iconLeft?: string;
  /** Lucide icon name rendered after the label. Use "arrow-right" on forward CTAs. */
  iconRight?: string;
  fullWidth?: boolean;
  disabled?: boolean;
  /** Renders an <a> instead of a <button>. */
  href?: string;
  type?: "button" | "submit" | "reset";
  onClick?: (e: React.MouseEvent) => void;
  className?: string;
  style?: React.CSSProperties;
}
export declare function Button(props: ButtonProps): JSX.Element;
