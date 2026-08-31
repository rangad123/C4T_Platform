export interface ContactFormProps {
  title?: string;
  description?: string;
  submitLabel?: string;
  /** Receives the form values on submit; the component shows its own success state. */
  onSubmit?: (values: Record<string, string>) => void;
  style?: React.CSSProperties;
  className?: string;
}
export declare function ContactForm(props: ContactFormProps): JSX.Element;
