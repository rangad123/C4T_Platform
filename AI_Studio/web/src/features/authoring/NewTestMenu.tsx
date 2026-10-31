import { Code2, FileText, FileUp, ListPlus, PencilLine, Plus, Smartphone, Video } from "lucide-react";
import { useState } from "react";
import type { ProjectDetail } from "../../api";
import { Menu, MenuItem, MenuLabel } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { go, routes } from "../../lib/router";
import { BuildTestDialog } from "../builder/BuildTestButton";
import { WriteCodeDialog } from "../code/WriteCodeDialog";
import { WriteTextDialog } from "../dsl/WriteAsText";
import { NEED_APP, NEED_PACKAGE, PHONE_TITLE, appState } from "../phone/phone";
import { PhoneStartDialog } from "../phone/PhoneStart";

/**
 * The phone entry of the menu. It reads the project only when the menu is open, and says in its line whether there is an app to explore;
 * without one it opens Settings, Mobile app instead of a panel that could not start.
 */
function PhoneEntry({ projectId, done, open }: { projectId: string; done: () => void; open: () => void }) {
    const project = useFetch<ProjectDetail>(`/projects/${projectId}`);
    const known = !project.loading && !project.error && project.data;
    const m = project.data?.mobile ?? null;
    const state = known ? appState(m) : "ready";
    const needApp = state === "none" || state === "needs-package";
    return (
        <MenuItem
            icon={Smartphone}
            description={needApp ? `${state === "needs-package" ? "Add the app’s package name first" : NEED_APP}. Opens Settings, Mobile app.` : state === "ios-only" ? "Android only. For iPhone apps, import tests." : "The AI opens your Android app, taps through it and plans tests. Uses the AI model."}
            onClick={() => {
                done();
                if (needApp) go(routes.setup(projectId, "mobile"));
                else open();
            }}
        >
            {PHONE_TITLE}
        </MenuItem>
    );
}

/**
 * The one way to start a test. Every entry says in a line what it is and what it needs, and opens the dialog or page that
 * already existed: only the entry points moved here. The ones that need the Tests page's own state (the AI dialog, the import
 * chooser) call back; the rest open from here.
 */
export function NewTestMenu({ projectId, onDescribe, onImport, variant = "primary" }: { projectId: string; onDescribe: () => void; onImport: () => void; variant?: "primary" | "secondary" }) {
    const [dialog, setDialog] = useState<"build" | "text" | "code" | "phone" | null>(null);
    const close = () => setDialog(null);
    return (
        <>
            <Menu label="New test" icon={Plus} variant={variant} wide dataTour="new-test">
                {(done) => (
                    <>
                        <MenuLabel>With help</MenuLabel>
                        <MenuItem icon={PencilLine} description="The AI writes the steps from your words. Uses the AI model." onClick={() => { done(); onDescribe(); }}>
                            Describe it
                        </MenuItem>
                        <MenuItem icon={Video} href={routes.record(projectId)} download={false} description="Click through your application and we turn what you do into steps.">
                            Record it in a browser
                        </MenuItem>
                        <PhoneEntry projectId={projectId} done={done} open={() => setDialog("phone")} />
                        <MenuLabel>By hand</MenuLabel>
                        <MenuItem icon={ListPlus} description="Add the steps one by one. The script is made for you." onClick={() => { done(); setDialog("build"); }}>
                            Build steps by hand
                        </MenuItem>
                        <MenuItem icon={FileText} description="One line per step, in fixed words. No AI needed." onClick={() => { done(); setDialog("text"); }}>
                            Write it as text
                        </MenuItem>
                        <MenuItem icon={Code2} description="Write the script yourself. Runs only where code tests are allowed." onClick={() => { done(); setDialog("code"); }}>
                            Write code
                        </MenuItem>
                        <MenuLabel>From elsewhere</MenuLabel>
                        <MenuItem icon={FileUp} description="From a JSON file, Maestro flows or a Git repository." onClick={() => { done(); onImport(); }}>
                            Import tests…
                        </MenuItem>
                    </>
                )}
            </Menu>
            {dialog === "build" && <BuildTestDialog projectId={projectId} onClose={close} />}
            {dialog === "text" && <WriteTextDialog projectId={projectId} onClose={close} />}
            {dialog === "code" && <WriteCodeDialog projectId={projectId} onClose={close} />}
            {dialog === "phone" && <PhoneStartDialog projectId={projectId} onClose={close} />}
        </>
    );
}

