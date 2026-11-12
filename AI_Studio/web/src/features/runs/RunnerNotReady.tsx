import { Callout, LinkButton } from "../../components/ui";
import { routes } from "../../lib/router";
import { NO_RUNNER_TITLE } from "../runners/my-runner";

/**
 * Said once, before the click, wherever a start is off because of the person's runner (not set up, offline, can't do this): the reason
 * from `useReadiness`, with the way to Settings. A refusal after the click is RunStartError's.
 */
export function RunnerNotReady({ reason, testId = "no-runner" }: { reason: string | null; testId?: string }) {
    if (!reason) return null;
    return (
        <div data-testid={testId}>
            <Callout tone="warning" title={NO_RUNNER_TITLE} actions={<LinkButton size="sm" variant="primary" href={routes.yourRunner}>Open Your runner in Settings</LinkButton>}>
                {reason}
            </Callout>
        </div>
    );
}
