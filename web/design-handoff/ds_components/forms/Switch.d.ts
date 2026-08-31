export interface SwitchProps {
  label?: React.ReactNode;
  checked?: boolean;
  /** Fired on click — the component is controlled. */
  onChange?: (e: React.MouseEvent) => void;
  disabled?: boolean;
  id?: string;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Switch(props: SwitchProps): JSX.Element;
