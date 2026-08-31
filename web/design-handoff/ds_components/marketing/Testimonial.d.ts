export interface TestimonialProps {
  quote: React.ReactNode;
  name?: string;
  role?: string;
  company?: string;
  /** Optional proof number attached to the quote. */
  metric?: string;
  metricLabel?: string;
  tone?: "canvas" | "inverse";
  /** feature = large borderless pull-quote; card = bordered grid item. */
  variant?: "card" | "feature";
  style?: React.CSSProperties;
  className?: string;
}
export declare function Testimonial(props: TestimonialProps): JSX.Element;
