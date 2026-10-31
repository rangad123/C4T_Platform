import { Rocket } from "lucide-react";
import type { Job } from "../../api";
import { Badge } from "../../components/ui";

/** Marks a run that a deploy pipeline started, with the commit when it said which one (nothing for other runs). */
export function DeployBadge({ job }: { job: Pick<Job, "trigger" | "deploy"> }) {
    if (job.trigger !== "deploy") return null;
    const commit = job.deploy?.commit;
    const env = job.deploy?.environment;
    const title = ["Started by a deploy", env ? `to ${env}` : "", commit ? `(commit ${commit})` : ""].filter(Boolean).join(" ");
    return (
        <Badge tone="info" icon={Rocket} title={title}>
            After a deploy{commit ? ` · ${commit.slice(0, 8)}` : ""}
        </Badge>
    );
}
