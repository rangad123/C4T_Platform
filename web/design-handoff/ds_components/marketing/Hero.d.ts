/**
 * @startingPoint section="Marketing" subtitle="Split or centred page hero with CTAs" viewport="1360x640"
 */
export interface HeroProps {
  eyebrow?: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  primaryCta?: string;
  secondaryCta?: string;
  /** Checklist under the deck — max 3. */
  bullets?: string[];
  /** Custom media node; pass false to omit entirely (centred layout only). */
  media?: React.ReactNode | false;
  tone?: "canvas" | "sunken" | "inverse";
  align?: "split" | "center";
  /** Small line under the CTAs — compliance or social proof. */
  trustLine?: string;
  onAction?: (label: string) => void;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Hero(props: HeroProps): JSX.Element;
