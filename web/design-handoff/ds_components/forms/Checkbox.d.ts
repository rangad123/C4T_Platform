export interface CheckboxProps {
  label?: React.ReactNode;
  /** Secondary line below the label — consent copy, explainers. */
  description?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  id?: string;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Checkbox(props: CheckboxProps): JSX.Element;
