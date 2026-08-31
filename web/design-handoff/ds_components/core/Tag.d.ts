export interface TagProps {
  children?: React.ReactNode;
  /** Selected state — ink fill, white label. */
  active?: boolean;
  href?: string;
  onClick?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Tag(props: TagProps): JSX.Element;
