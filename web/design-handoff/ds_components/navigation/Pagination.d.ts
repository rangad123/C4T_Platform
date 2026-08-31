export interface PaginationProps {
  page?: number;
  pageCount?: number;
  onChange?: (page: number) => void;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Pagination(props: PaginationProps): JSX.Element;
