import { Callout } from "../../components/ui";
import { describeApiError } from "../../lib/labels";
import { RunStartError } from "../runners/RunnerRefusal";
import { isRunnerRefusal, type Readiness } from "../runners/my-runner";
import { RunnerNotReady } from "./RunnerNotReady";
import { exploresOnRunner } from "./runs-here";

/** Runners mode, before the click: why the person's runner can't explore now (with the way to Settings), or which runner it explores on. */
export function ExploreOnRunnerNote({ ready }: { ready: Readiness }) {
    if (ready.reason) return <RunnerNotReady reason={ready.reason} testId="explore-runner-problem" />;
    if (!ready.runner) return null;
    return (
        <p className="t-secondary" data-testid="explore-on-hint">
            {exploresOnRunner(ready.runner.name)}
        </p>
    );
}

/** An exploration that could not start: the server's sentence, with the link to Your runner when the person's runner is the reason. */
export function ExploreStartError({ error }: { error: unknown }) {
    if (isRunnerRefusal(error)) return <RunStartError error={error} />;
    return <Callout tone="danger" title="We couldn’t start the exploration">{describeApiError(error)}</Callout>;
}
