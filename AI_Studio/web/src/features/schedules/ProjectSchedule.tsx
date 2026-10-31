import { useState } from "react";
import type { Job } from "../../api";
import { useFetch, useOnFinish } from "../../lib/hooks";
import { isActive } from "../../lib/labels";
import { useRoute } from "../../lib/router";
import { RunbooksPanel } from "../runbooks/RunbooksPanel";
import { TriggersPanel } from "../triggers/TriggersPanel";
import { FlakyPanel } from "./FlakyPanel";
import { SchedulesPanel } from "./SchedulesPanel";
import { TrendChart } from "./TrendChart";

/** Which part of the Runs place: scheduled runs and run sequences, runs started by a deploy, or how results develop. */
export type ScheduleSection = "schedules" | "deploys" | "trends";

/**
 * The automatic side of the Runs place. Shown inside it, so it has no title or tab bar of its own: the place owns them.
 * While a run is going it keeps an eye on it, and when it ends everything that depends on its results is refreshed.
 */
export function ProjectSchedule({ id, section }: { id: string; section: ScheduleSection }) {
    // A link from a run-sequence message names one run to show.
    const focusRunId = useRoute().query.get("run") ?? undefined;
    const jobs = useFetch<Job[]>(`/projects/${id}/jobs`, (d) => (d?.some((j) => isActive(j.status)) ? 2500 : null));
    const running = !!jobs.data?.some((j) => isActive(j.status));
    const [reloadKey, setReloadKey] = useState(0);
    const bump = () => setReloadKey((k) => k + 1);
    useOnFinish(running, bump);

    return (
        <div className="stack">
            {section === "schedules" && (
                <>
                    <SchedulesPanel
                        projectId={id}
                        reloadKey={reloadKey}
                        onRunStarted={() => {
                            // A started run shows up in the job list; polling then follows it to the end.
                            void jobs.reload();
                        }}
                    />
                    <RunbooksPanel projectId={id} reloadKey={reloadKey} focusRunId={focusRunId} onLinked={bump} />
                </>
            )}
            {section === "trends" && (
                <>
                    <TrendChart projectId={id} reloadKey={reloadKey} />
                    <FlakyPanel projectId={id} reloadKey={reloadKey} />
                </>
            )}
            {section === "deploys" && <TriggersPanel projectId={id} reloadKey={reloadKey} />}
        </div>
    );
}
