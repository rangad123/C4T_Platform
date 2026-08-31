export interface IconProps {
  /** Lucide icon name in kebab-case, e.g. "check-circle", "bot", "users". */
  name: string;
  /** Square px size. 16 inline, 20 default UI, 24 nav, 32 feature. */
  size?: number;
  /** CSS color; defaults to currentColor. */
  color?: string;
  style?: React.CSSProperties;
  className?: string;
  /** Accessible name. Omit for decorative icons (renders aria-hidden). */
  label?: string;
}
export declare function Icon(props: IconProps): JSX.Element;
