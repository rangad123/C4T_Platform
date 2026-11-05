import { useConfig } from "../../lib/hooks";

/** Said before a click wherever a run or an exploration would start, while tests are switched off on this server (no worker). */
export const RUNS_OFF_HERE = "Tests are switched off on this server, so no run starts here.";
export const RUNS_OFF_TIP = "Tests are switched off on this server: a run started here would never start.";
export const EXPLORING_OFF_HERE = "Tests are switched off on this server, so exploring does not start here.";

/** False only when the server says runs cannot start here; true until it answers (and on an older server that does not say). */
export function useRunsHere(): boolean {
    return useConfig()?.runsHere !== false;
}
