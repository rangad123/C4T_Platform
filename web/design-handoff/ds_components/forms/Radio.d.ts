export interface RadioProps {
  label?: React.ReactNode;
  description?: string;
  name?: string;
  value?: string;
  checked?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  id?: string;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Radio(props: RadioProps): JSX.Element;
