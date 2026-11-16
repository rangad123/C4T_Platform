import { Code2, FileText, ListPlus, PencilLine, Plus } from "lucide-react";
import { useState } from "react";
import { projectShape, type ProjectDetail } from "../../api";
import { Menu, MenuItem, MenuLabel } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { useHere } from "../auth/project-access";
import { BUILDS_ON_RUNNER, useRunsHere } from "../runs/runs-here";
import { useReadiness } from "../runners/my-runner";
import { BuildTestDialog } from "../builder/BuildTestButton";
import { WriteCodeDialog } from "../code/WriteCodeDialog";
import { WriteTextDialog } from "../dsl/WriteAsText";

/**
 * The ways to write a new test script. Every entry says in a line what it is and what it needs, and opens the dialog or page that
 * already existed. Describe it needs the list's own state (the AI dialog) and calls back; the rest open from here. Bringing scripts
 * in is the list's Import button, and the AI writes scripts from test cases on Test cases (Generate test scripts): neither is
 * repeated here. Recording in a browser and exploring the phone app are not ways of making a script here either.
 */
export function NewTestMenu({ projectId, onDescribe, variant = "primary" }: { projectId: string; onDescribe: () => void; variant?: "primary" | "secondary" }) {
    const [dialog, setDialog] = useState<"build" | "text" | "code" | null>(null);
    const close = () => setDialog(null);
    // Describing a test and the DSL make web and API tests only: a project without the web platform (a phone app) is told so, and
    // they are not offered there (the server refuses a described test for an app, and the DSL has no phone steps yet).
    const project = useFetch<ProjectDetail>(`/projects/${projectId}`);
    const webOnly = project.data ? !projectShape(project.data).platforms.includes("web") : false;
    const PHONE = "Web and API only: this project tests a phone app.";
    // The AI writes a described test inside a run: while tests are switched off on this server it is said here, before the click.
    const runsHere = useRunsHere();
    // Runners mode (round 52): the described test is built on the person's runner, so it needs one that is set up, online and new enough.
    const ready = useReadiness({ can: ["web", "plain"] });
    const runnersOnly = ready.mode === "runners";
    const here = useHere(projectId, project);
    // Every way in makes a test script (ai_studio.tests.write in this project): without it the menu is switched off with the reason.
    const writeWhy = here.why("ai_studio.tests.write");
    return (
        <>
            <Menu label="New test script" icon={Plus} variant={variant} wide dataTour="new-test" disabled={Boolean(writeWhy)} tip={writeWhy}>
                {(done) => (
                    <>
                        <MenuLabel>With help</MenuLabel>
                        <MenuItem icon={PencilLine} description={webOnly ? PHONE : runnersOnly ? (ready.reason ?? BUILDS_ON_RUNNER) : !runsHere ? "Tests are switched off on this server, and the AI writes a described test inside a run." : "The AI writes the steps from your words. Uses your AI key."} disabled={webOnly || (runnersOnly ? !ready.ready : !runsHere)} onClick={() => { done(); onDescribe(); }}>
                            Describe it
                        </MenuItem>
                        <MenuLabel>By hand</MenuLabel>
                        <MenuItem icon={ListPlus} description="Add the steps one by one. The script is made for you." onClick={() => { done(); setDialog("build"); }}>
                            Build steps by hand
                        </MenuItem>
                        <MenuItem icon={FileText} description={webOnly ? PHONE : "The DSL: one line per step, in fixed words. No AI needed."} disabled={webOnly} onClick={() => { done(); setDialog("text"); }}>
                            Write it as text
                        </MenuItem>
                        <MenuItem icon={Code2} description="Write the script yourself. Runs only where code tests are allowed." onClick={() => { done(); setDialog("code"); }}>
                            Write code
                        </MenuItem>
                    </>
                )}
            </Menu>
            {dialog === "build" && <BuildTestDialog projectId={projectId} onClose={close} />}
            {dialog === "text" && <WriteTextDialog projectId={projectId} onClose={close} />}
            {dialog === "code" && <WriteCodeDialog projectId={projectId} onClose={close} />}
        </>
    );
}
