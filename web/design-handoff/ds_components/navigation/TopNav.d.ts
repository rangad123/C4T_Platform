export interface MegaLink { icon: string; label: string; desc?: string; href?: string }
export interface MegaColumn { title: string; links: MegaLink[] }
export interface NavItem {
  label: string;
  href?: string;
  /** Present = renders a full-width mega menu on hover. */
  columns?: MegaColumn[];
  /** Optional promoted panel on the right of the mega menu. */
  feature?: { badge?: string; title: string; desc: string; cta: string };
}
/**
 * @startingPoint section="Navigation" subtitle="Sticky global header with mega menus" viewport="1360x520"
 */
export interface TopNavProps {
  /** Defaults to the full Crowd4Test IA (Platform, Solutions, Industries, Services, Resources, Pricing, Company). */
  items?: NavItem[];
  /** Label of the current section — renders the link in ink. */
  active?: string;
  /** Called with the clicked label; wire it to your router. */
  onNavigate?: (label: string) => void;
  sticky?: boolean;
  /** Optional dark strip above the bar. */
  announcement?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}
export declare const DEFAULT_NAV: NavItem[];
export declare function TopNav(props: TopNavProps): JSX.Element;
