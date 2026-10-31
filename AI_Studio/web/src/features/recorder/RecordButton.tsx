import { Video } from "lucide-react";
import { routes } from "../../lib/router";

/** "Record a test" on the Tests page: a link to the recorder page, styled like the other header buttons. */
export function RecordButton({ projectId, primary }: { projectId: string; primary?: boolean }) {
    return (
        <a className={`btn${primary ? " btn-primary" : ""}`} href={routes.record(projectId)}>
            <Video size={18} aria-hidden />
            Record a test
        </a>
    );
}
