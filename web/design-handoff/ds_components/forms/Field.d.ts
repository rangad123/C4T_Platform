export interface FieldProps {
  /** Label text rendered above the control. */
  label?: string;
  /** Helper text below the control; hidden when `error` is set. */
  hint?: string;
  /** Error message; replaces the hint and renders in error red. */
  error?: string;
  required?: boolean;
  /** id of the control this label points at. */
  htmlFor?: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Field(props: FieldProps): JSX.Element;
