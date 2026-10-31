import { FileJson, FileText, FileUp, FolderArchive, GitBranch, ListChecks } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { Button } from "../../components/ui";
import { Modal } from "../code/Modal";

/** One choice in a dialog: what it does in a line, and the button that does it. */
function Choice({ icon: Icon, title, text, children }: { icon: typeof FileUp; title: string; text: string; children: ReactNode }) {
    return (
        <li className="choice-row">
            <Icon size={18} aria-hidden />
            <span className="choice-text">
                <b>{title}</b>
                <span className="t-secondary">{text}</span>
            </span>
            {children}
        </li>
    );
}

/** "Import tests…": the three places tests can come from. Each opens the dialog or file chooser that already existed. */
export function ImportDialog({ onClose, onJsonFile, onMaestro, onGit, disabled }: { onClose: () => void; onJsonFile: (f: File) => void; onMaestro: () => void; onGit: () => void; disabled?: boolean }) {
    const file = useRef<HTMLInputElement>(null);
    return (
        <Modal title="Import tests" titleId="import-title" onClose={onClose}>
            <div className="stack-sm">
                <p className="t-secondary">Bring in tests you already have. They are checked and run once, like any new test.</p>
                <input
                    ref={file}
                    type="file"
                    accept="application/json,.json"
                    hidden
                    aria-label="Test file in JSON"
                    onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        if (!f) return;
                        onClose();
                        onJsonFile(f);
                    }}
                />
                <ul className="choice-list">
                    <Choice icon={FileJson} title="A JSON file" text="Tests exported from this platform, or written in its JSON format.">
                        <Button size="sm" disabled={disabled} onClick={() => file.current?.click()}>
                            Choose a JSON file
                        </Button>
                    </Choice>
                    <Choice icon={FileUp} title="Maestro flows" text="YAML flows for phone apps. You see what each becomes before importing.">
                        <Button size="sm" onClick={() => { onClose(); onMaestro(); }}>
                            Import Maestro flows
                        </Button>
                    </Choice>
                    <Choice icon={GitBranch} title="A Git repository" text="Playwright test files. They come in as code tests.">
                        <Button size="sm" onClick={() => { onClose(); onGit(); }}>
                            Import from Git
                        </Button>
                    </Choice>
                </ul>
                <div className="foot">
                    <Button onClick={onClose}>Close</Button>
                </div>
            </div>
        </Modal>
    );
}

export interface ExportItem {
    key: string;
    title: string;
    text: string;
    button: string;
    icon: typeof FileText;
    disabled?: boolean;
    /** Why the button is disabled, or what it gives when that is not obvious (a tooltip). */
    tip?: string;
    run: () => void;
}

/** "Export…": every download of the project in one place, each with what is in it and who it is for. */
export function ExportDialog({ items, onClose }: { items: ExportItem[]; onClose: () => void }) {
    return (
        <Modal title="Export" titleId="export-title" onClose={onClose}>
            <div className="stack-sm">
                <p className="t-secondary">Take your tests or their results out of the platform.</p>
                <ul className="choice-list">
                    {items.map((i) => (
                        <Choice key={i.key} icon={i.icon} title={i.title} text={i.text}>
                            <Button size="sm" disabled={i.disabled} tip={i.tip} onClick={() => { onClose(); i.run(); }}>
                                {i.button}
                            </Button>
                        </Choice>
                    ))}
                </ul>
                <div className="foot">
                    <Button onClick={onClose}>Close</Button>
                </div>
            </div>
        </Modal>
    );
}

export const EXPORT_ICONS = { zip: FolderArchive, json: FileJson, report: FileText, junit: ListChecks };
