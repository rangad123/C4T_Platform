import type { Job } from "../../api";
import { Badge } from "../../components/ui";
import { RUN_STATUS_HELP, runStatusOf, statusWords } from "./workspace";

/** One run's status in the Workspace's words (the CONTRACT status list), never a test suite's (W3 review M3, L5). */
export function RunStatus({ job }: { job: Job }) {
    const s = runStatusOf(job);
    const w = statusWords({ status: s, lastRun: job });
    return (
        <Badge tone={w.tone} tip={RUN_STATUS_HELP[s]} tipFocusable>
            {w.label}
        </Badge>
    );
}
