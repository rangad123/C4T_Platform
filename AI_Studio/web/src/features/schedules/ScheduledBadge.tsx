import { CalendarClock } from "lucide-react";
import type { Job } from "../../api";
import { Badge } from "../../components/ui";

/** Marks a run that a schedule started (nothing for runs started by a person). */
export function ScheduledBadge({ job }: { job: Pick<Job, "trigger"> }) {
    return job.trigger === "schedule" ? (
        <Badge tone="info" icon={CalendarClock} title="Started by a schedule">
            Scheduled
        </Badge>
    ) : null;
}
