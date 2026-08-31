export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  rows?: number;
  invalid?: boolean;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Textarea(props: TextareaProps): JSX.Element;
