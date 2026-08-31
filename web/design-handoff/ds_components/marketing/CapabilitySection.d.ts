export interface Capability { icon?: string; title: string; description?: string }
export interface CapabilitySectionProps {
  eyebrow?: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Clickable list; the first is active on mount. */
  capabilities?: Capability[];
  /** Custom media node for the right-hand plate. */
  media?: React.ReactNode;
  tone?: "canvas" | "sunken" | "inverse";
  /** Put the media on the left. */
  reverse?: boolean;
  style?: React.CSSProperties;
  className?: string;
}
export declare function CapabilitySection(props: CapabilitySectionProps): JSX.Element;
