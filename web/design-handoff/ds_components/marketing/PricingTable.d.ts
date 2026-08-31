export interface PricingPlan {
  name: string;
  description?: string;
  price: string;
  period?: string;
  cta?: string;
  badge?: string;
  /** Renders the dark, elevated plan. Use on exactly one plan. */
  highlighted?: boolean;
  featuresLabel?: string;
  features?: string[];
}
export interface PricingTableProps {
  plans?: PricingPlan[];
  note?: string;
  onSelect?: (planName: string) => void;
  style?: React.CSSProperties;
  className?: string;
}
export declare function PricingTable(props: PricingTableProps): JSX.Element;
