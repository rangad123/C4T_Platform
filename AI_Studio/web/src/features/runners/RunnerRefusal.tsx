import { Callout } from "../../components/ui";
import { describeApiError } from "../../lib/labels";
import { refusalLink } from "./my-runner";

/** A run, recording or session that could not start: the server's sentence, with a link to Settings when the person's runner is the reason. */
export function RunStartError({ error }: { error: unknown }) {
    const link = refusalLink(error);
    return (
        <div data-testid="run-start-error">
            <Callout tone="danger" actions={link ? <a href={link}>Open Your runner in Settings</a> : undefined}>
                {describeApiError(error)}
            </Callout>
        </div>
    );
}
