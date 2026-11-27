import { Callout, LinkButton } from "../../components/ui";
import { routes } from "../../lib/router";
import { NO_RUNNER_TITLE } from "../runners/my-runner";
import { RUNS_OFF_TIP } from "./runs-here";

/**
 * Said once, before the click, wherever a start is off because of the person's runner (not set up, offline, can't do this): the reason
 * from `useReadiness`, with the way to Settings. A refusal after the click is RunStartError's.
 */
export function RunnerNotReady({ reason, testId = "no-runner" }: { reason: string | null; testId?: string }) {
    if (!reason) return null;
    // No worker on this server: nothing in the person's runner settings changes that, so no link there.
    const server = reason === RUNS_OFF_TIP;
    return (
        <div data-testid={testId}>
            <Callout tone="warning" title={server ? "Runs can’t start on this server yet" : NO_RUNNER_TITLE} actions={server ? undefined : <LinkButton size="sm" variant="primary" href={routes.yourRunner}>Open Your runner in Settings</LinkButton>}>
                {reason}
            </Callout>
        </div>
    );
}
