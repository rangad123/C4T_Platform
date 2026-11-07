import { useEffect, useState } from "react";
import { Tooltip } from "../../components/Tooltip";
import { duration, relativeTime } from "../../lib/format";

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

/** Seconds since a moment, ticking. Never a live region; `hidden` (the strip) also keeps it from screen readers, where the status line speaks instead. */
export function Elapsed({ since, hidden = true }: { since: string | null; hidden?: boolean }) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const t = window.setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);
    if (!since) return null;
    return <span aria-hidden={hidden || undefined}>{duration(Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000) * 1000))}</span>;
}
