import { Download, MoreHorizontal, ShieldOff, Smartphone, ThumbsUp } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Menu, MenuItem, PageHeader, SeverityBadge, StatusBadge } from "../../components/ui";
import { downloadBlob, relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { KIND_LABEL, PRIORITY_LABEL, typeLabel } from "../../lib/labels";
import { HandWrittenBadge } from "../code/TakeOver";
import { OriginBadge } from "../code/CustomParts";
import { OriginStrip } from "../provenance/OriginStrip";
import { QuarantineDialog } from "../quarantine/QuarantineDialog";
import type { TestQuarantine } from "../quarantine/quarantine";
import { RunMenu } from "../runs/RunMenu";
import type { Detail } from "./test-model";
import "./workbench.css";

/**
 * The top of the workbench, the same for every tab: the name, the verdict in the decided words, when it last ran, where the test came
 * from, Run, and the "More actions" menu (quarantine, download the script, a mobile version).
 */
export function TestHeader({
    test: t,
    pluginName,
    busy,
    canAccept,
    canMobile,
    onAccept,
    onMobile,
    onStarted,
    onError,
    onQuarantineChanged,
}: {
    test: Detail;
    pluginName?: string;
    busy: "" | "validate" | "baseline";
    canAccept: boolean;
    canMobile: boolean;
    onAccept: () => void;
    onMobile: () => void;
    onStarted: (jobId: string) => void;
    onError: (message: string) => void;
    onQuarantineChanged: () => void;
}) {
    const last = t.executions[0];
    const isMobile = t.framework === "taqwright" || t.framework === "taqwright-ios";
    const quarantine = useFetch<TestQuarantine>(`/tests/${t.id}/quarantine`);
    const [dialog, setDialog] = useState<"quarantine" | "release" | null>(null);
    const q = quarantine.data;
    const script = t.scripts.find((s) => s.framework === t.framework) ?? t.scripts[0];

    return (
        <>
            <PageHeader
                title={t.title}
                subtitle={
                    <>
                        {/* The one status of this page: a tab stop, so the keyboard can read what it means (docs/features/tooltips.md). */}
                        <StatusBadge status={t.validationStatus} tipFocusable />
                        {t.severity && <SeverityBadge severity={t.severity.severity} basis={t.severity.basis} tipFocusable />}
                        {pluginName && (
                            <Badge tone="info" title={`Runs with the plug-in ${pluginName}`}>
                                Plug-in
                            </Badge>
                        )}
                        {t.custom && (
                            <>
                                <HandWrittenBadge />
                                <OriginBadge custom={t.custom} />
                            </>
                        )}
                        <span className="t-meta" data-testid="test-meta">
                            {typeLabel(t.type)}
                            <span className="dot-sep" />
                            {PRIORITY_LABEL[t.priority]}
                            <span className="dot-sep" />
                            {KIND_LABEL[t.kind]}
                            <span className="dot-sep" />
                            <span className="mono">{t.testId}</span>
                        </span>
                        {last && (
                            <span className="t-meta" data-testid="last-run">
                                Last run {relativeTime(last.startedAt)}
                            </span>
                        )}
                    </>
                }
                actions={
                    <>
                        {canAccept && (
                            <Button variant="primary" icon={ThumbsUp} loading={busy === "baseline"} disabled={!!busy} onClick={onAccept} tip="The change is intended: the new screenshot becomes the approved one, and the test runs again against it.">
                                Accept new screenshot
                            </Button>
                        )}
                        {(!isMobile || t.kind === "mobile") && <RunMenu projectId={t.projectId} scope="test" test={{ id: t.id, kind: t.kind, custom: t.custom }} split onStarted={onStarted} onError={onError} />}
                        <Menu label="More actions" icon={MoreHorizontal} iconOnly>
                            {(close) => (
                                <>
                                    {q?.entry ? (
                                        <MenuItem icon={ShieldOff} onClick={() => (close(), setDialog("release"))}>
                                            Release from quarantine
                                        </MenuItem>
                                    ) : (
                                        <MenuItem
                                            icon={ShieldOff}
                                            disabled={!q?.eligible}
                                            description={q?.eligible ? "It keeps running but stops counting against pass rates, alerts and sign-off." : "Only a test that passes and fails on identical runs can be quarantined."}
                                            onClick={() => (close(), setDialog("quarantine"))}
                                        >
                                            Quarantine
                                        </MenuItem>
                                    )}
                                    {script && (
                                        <MenuItem icon={Download} onClick={() => (close(), downloadBlob(new Blob([script.content], { type: "text/plain" }), script.filename))}>
                                            Download script
                                        </MenuItem>
                                    )}
                                    {canMobile && (
                                        <MenuItem icon={Smartphone} onClick={() => (close(), onMobile())} hint="Appium" tip="Writes these steps as an Appium script and opens it in the Code tab. The script is kept, not run here.">
                                            Create mobile version
                                        </MenuItem>
                                    )}
                                </>
                            )}
                        </Menu>
                    </>
                }
            />
            <OriginStrip test={t} />
            {dialog && q && (
                <QuarantineDialog
                    projectId={t.projectId}
                    testId={t.id}
                    title={t.title}
                    mode={dialog}
                    entryId={q.entry?.id}
                    suggestedReason={q.suggestedReason}
                    onClose={() => setDialog(null)}
                    onDone={() => {
                        setDialog(null);
                        void quarantine.reload();
                        onQuarantineChanged();
                    }}
                />
            )}
        </>
    );
}
