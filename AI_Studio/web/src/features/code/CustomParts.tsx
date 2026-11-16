import "./code.css";
import { Undo2 } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Callout, LinkButton } from "../../components/ui";
import { routes } from "../../lib/router";
import { ORIGIN_LABEL, shortCommit, type CustomInfo } from "./code";
import { Modal } from "../../components/Modal";
import { api } from "../../api";
import { describeApiError } from "../../lib/labels";


/** The origin of a code test in words, as a small badge. */
export function OriginBadge({ custom }: { custom: CustomInfo }) {
    return <Badge tone="neutral">{ORIGIN_LABEL[custom.origin]}</Badge>;
}

interface RepoRow { id: string; host: string; path: string; ref: string; commit: string }
interface CheckResult { upToDate: boolean; newCommit?: string; changed: Array<{ testId: string; path: string }> }

/**
 * On a code test's Code tab, one line: where it came from in Git, and what can be done that the editor cannot (go back to the
 * generated version, check the repository). The header already says it is a code test; versions are on the History tab.
 */
export function CustomCallout({ testId, projectId, custom, onChanged }: { testId: string; projectId: string; custom: CustomInfo; onChanged: () => void }) {
    const [confirm, setConfirm] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [checking, setChecking] = useState(false);
    const [check, setCheck] = useState<{ ok: true; res: CheckResult } | { ok: false; text: string } | null>(null);

    async function goBack() {
        setBusy(true);
        setError("");
        try {
            await api(`/tests/${testId}/restore-generated`, { method: "POST", body: { confirm: true } });
            setConfirm(false);
            onChanged();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy(false);
        }
    }

    async function checkGit() {
        const g = custom.git;
        if (!g) return;
        setChecking(true);
        setCheck(null);
        try {
            const repos = await api<RepoRow[]>(`/projects/${projectId}/git-imports`);
            const repo = repos.find((r) => r.host === g.host && r.path === g.path && r.ref === g.ref) ?? repos.find((r) => r.host === g.host && r.path === g.path);
            if (!repo) throw new Error("This repository is no longer linked. Import it again from Test scripts, Import, Import from Git.");
            setCheck({ ok: true, res: await api<CheckResult>(`/projects/${projectId}/git-imports/${repo.id}/check`, { method: "POST" }) });
        } catch (e) {
            setCheck({ ok: false, text: describeApiError(e) });
        } finally {
            setChecking(false);
        }
    }

    return (
        <>
            {(custom.canRestoreGenerated || custom.git) && (
                <div className="row" data-testid="custom-line">
                    {custom.git && (
                        <span className="t-secondary" data-testid="git-line">
                            From {custom.git.host}/{custom.git.path}, {custom.git.ref}, commit {shortCommit(custom.git.commit)}
                        </span>
                    )}
                    {custom.canRestoreGenerated && (
                        <Button size="sm" icon={Undo2} onClick={() => setConfirm(true)}>
                            Go back to the generated version
                        </Button>
                    )}
                    {custom.git && (
                        <Button size="sm" loading={checking} tip="Compares this test with the newest commit of its repository. Nothing is changed." onClick={() => void checkGit()}>
                            Check for updates
                        </Button>
                    )}
                </div>
            )}
            {check && (
                <div role="status" data-testid="git-check">
                    {check.ok ? (
                        check.res.upToDate ? (
                            <Callout tone="success">This test is up to date with the repository.</Callout>
                        ) : (
                            <Callout tone="warning" title="The repository has changed" actions={<LinkButton size="sm" href={`${routes.tests(projectId)}?git=1`}>Open repositories to refresh</LinkButton>}>
                                {check.res.newCommit ? `Newest commit ${shortCommit(check.res.newCommit)}. ` : ""}
                                {check.res.changed.length} {check.res.changed.length === 1 ? "test differs" : "tests differ"}: {check.res.changed.map((c) => c.path).join(", ") || "none listed"}.
                            </Callout>
                        )
                    ) : (
                        <Callout tone="danger" title="We couldn’t check the repository">{check.text}</Callout>
                    )}
                </div>
            )}
            {confirm && (
                <Modal
                    title="Go back to the generated version?"
                    titleId="code-restoregen-title"
                    onClose={() => setConfirm(false)}
                    foot={
                        <>
                            <Button data-autofocus onClick={() => setConfirm(false)}>
                                Keep my script
                            </Button>
                            <Button variant="primary" loading={busy} onClick={() => void goBack()}>
                                Go back to the generated version
                            </Button>
                        </>
                    }
                >
                    <p className="t-secondary">The script is made again from the test’s original steps. Your edits stay in the version history, so you can restore them later.</p>
                    {error && <Callout tone="danger">{error}</Callout>}
                </Modal>
            )}
        </>
    );
}
