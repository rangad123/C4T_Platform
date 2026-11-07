import { Code2, FileText, FileUp, ListPlus, PencilLine, Plus } from "lucide-react";
import { useState } from "react";
import { projectShape, type ProjectDetail } from "../../api";
import { Menu, MenuItem, MenuLabel } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { PLAIN_ON_RUNNERS, useExecutionMode, useRunsHere } from "../runs/runs-here";
import { BuildTestDialog } from "../builder/BuildTestButton";
import { WriteCodeDialog } from "../code/WriteCodeDialog";
import { WriteTextDialog } from "../dsl/WriteAsText";

/**
 * The one way to start a test script. Every entry says in a line what it is and what it needs, and opens the dialog or page that
 * already existed: only the entry points moved here. The ones that need the list's own state (the AI dialog, the import chooser)
 * call back; the rest open from here. Round 38: recording in a browser and exploring the phone app are not ways of making a script
 * here (the recorder opens from Test development, phone exploring from Settings, Mobile app).
 */
export function NewTestMenu({ projectId, onDescribe, onImport, variant = "primary" }: { projectId: string; onDescribe: () => void; onImport: () => void; variant?: "primary" | "secondary" }) {
    const [dialog, setDialog] = useState<"build" | "text" | "code" | null>(null);
    const close = () => setDialog(null);
    // Describing a test and the DSL make web and API tests only: a project without the web platform (a phone app) is told so, and
    // they are not offered there (the server refuses a described test for an app, and the DSL has no phone steps yet).
    const project = useFetch<ProjectDetail>(`/projects/${projectId}`);
    const webOnly = project.data ? !projectShape(project.data).platforms.includes("web") : false;
    const PHONE = "Web and API only: this project tests a phone app.";
    // The AI writes a described test inside a run: while tests are switched off on this server it is said here, before the click.
    const runsHere = useRunsHere();
    // Runners mode: the platform refuses a described test (the AI builds it with a browser on the server).
    const runnersOnly = useExecutionMode() === "runners";
    return (
        <>
            <Menu label="New test script" icon={Plus} variant={variant} wide dataTour="new-test">
                {(done) => (
                    <>
                        <MenuLabel>With help</MenuLabel>
                        <MenuItem icon={PencilLine} description={webOnly ? PHONE : runnersOnly ? PLAIN_ON_RUNNERS : !runsHere ? "Tests are switched off on this server, and the AI writes a described test inside a run." : "The AI writes the steps from your words. Uses the AI model."} disabled={webOnly || !runsHere || runnersOnly} onClick={() => { done(); onDescribe(); }}>
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
                        <MenuLabel>From elsewhere</MenuLabel>
                        <MenuItem icon={FileUp} description="From a JSON file, Maestro flows or a Git repository." onClick={() => { done(); onImport(); }}>
                            Import scripts…
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
