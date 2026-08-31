export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Lucide icon name rendered inside the left edge. */
  iconLeft?: string;
  /** Marks the control invalid — red border + aria-invalid. */
  invalid?: boolean;
  disabled?: boolean;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Input(props: InputProps): JSX.Element;
