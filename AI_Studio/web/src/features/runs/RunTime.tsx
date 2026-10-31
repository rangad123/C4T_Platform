import { Tooltip } from "../../components/Tooltip";
import { relativeTime } from "../../lib/format";

/** "3 min ago", with the full date and time as a tooltip on hover and keyboard focus (it used to be a native title, which neither shows). */
export function RelTime({ iso, className }: { iso: string; className?: string }) {
    return (
        <Tooltip content={new Date(iso).toLocaleString()}>
            <time className={className} dateTime={iso} tabIndex={0}>
                {relativeTime(iso)}
            </time>
        </Tooltip>
    );
}
