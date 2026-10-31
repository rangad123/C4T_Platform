import { ChevronDown, History, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { Badge, Button, Callout, EmptyState, ErrorState, ListSkeleton } from "../../components/ui";
import { BadgeKey, FieldHelp } from "../../components/Tooltip";
import { relativeTime } from "../../lib/format";
import { friendlyError } from "../../lib/labels";
import { go, useRoute } from "../../lib/router";
import { SecurityLayout } from "./SecurityChrome";
import { SEC, sec, securityError, useApps, when } from "./security";

/** One event of the project's security trail (GET /projects/:id/activity, CORE: src/security/store.ts `listAudit`). */
export interface ActivityEvent {
    id: number;
    at: string;
    projectId?: string;
    applicationId?: string | null;
    actor?: { kind?: string; id?: string | null; name?: string };
    action: string;
    objectType?: string;
    objectId?: string | null;
    summary: string;
}

/** What kind of change an event is, from the first word of its action ("assessment.started"). Unknown actions are "Other". */
export const ACTIVITY_KINDS: Array<{ key: string; label: string; help: string; actions: string[] }> = [
    { key: "application", label: "Applications", help: "Applications registered, changed or deleted, their API documents and saved sign-ins.", actions: ["application", "api-document", "sign-in"] },
    { key: "authorization", label: "Authorizations", help: "Authorizations recorded or withdrawn.", actions: ["authorization"] },
    { key: "assessment", label: "Assessments", help: "Assessments started, stopped, cancelled or finished.", actions: ["assessment"] },
    { key: "finding", label: "Findings", help: "Findings entered by hand and changes to a finding’s state.", actions: ["finding"] },
    { key: "report", label: "Reports", help: "Reports shown or downloaded, in any format.", actions: ["report"] },
    // "project": a backup downloaded without the security data, and a project restored from a backup (src/security/backup.ts).
    { key: "settings", label: "Settings and upkeep", help: "The project’s testing type, notifications, backups and restores, and old assessments removed after the retention period.", actions: ["testing-type", "retention", "notifications", "settings", "project"] },
];
/** What the "Other" badge means (an action this page does not know yet). */
const OTHER_HELP = "Something else done in the project’s security work; the line says what.";
const kindOf = (action: string) => ACTIVITY_KINDS.find((k) => k.actions.includes(action.split(".")[0] ?? ""))?.key ?? "other";
const kindLabel = (key: string) => ACTIVITY_KINDS.find((k) => k.key === key)?.label ?? "Other";

/** How many events one request asks for (the route answers at most 200). */
const PAGE = 100;

/** Where an event's object can be opened, when it still exists in a form the pages show. */
function linkOf(id: string, e: ActivityEvent): { href: string; label: string } | undefined {
    if (/\.deleted$/.test(e.action) || !e.objectId) return undefined;
    if (e.objectType === "application") return { href: sec.application(id, e.objectId), label: "Open the application" };
    if (e.objectType === "authorization" && e.applicationId) return { href: sec.application(id, e.applicationId), label: "Open the application" };
    if (e.objectType === "assessment") return { href: sec.assessment(id, e.objectId), label: "Open the assessment" };
    if (e.objectType === "finding") return { href: sec.finding(id, e.objectId), label: "Open the finding" };
    if (e.objectType === "report") return { href: e.objectId === id ? sec.reports(id) : sec.reports(id, e.objectId), label: "Open the report" };
    return undefined;
}

/**
 * The project's security trail: who did what and when, newest first. The application filter is the server's; what and who narrow the
 * events loaded so far ("Show older" loads more). The same events are listed in the platform's Activity (Settings, People).
 */
export function ActivityPage({ id }: { id: string }) {
    const { query } = useRoute();
    const application = query.get("application") ?? "";
    const kind = query.get("kind") ?? "";
    const person = query.get("person") ?? "";
    const apps = useApps(id);
    const [events, setEvents] = useState<ActivityEvent[]>();
    const [error, setError] = useState<Error>();
    const [more, setMore] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [moreError, setMoreError] = useState("");
    const [tick, setTick] = useState(0);

    const url = (before?: number) => `${SEC}/projects/${id}/activity?${new URLSearchParams({ limit: String(PAGE), ...(application ? { applicationId: application } : {}), ...(before ? { before: String(before) } : {}) })}`;

    useEffect(() => {
        let gone = false;
        setEvents(undefined);
        setError(undefined);
        setMoreError("");
        api<{ events?: ActivityEvent[] }>(url())
            .then((a) => {
                if (gone) return;
                const list = Array.isArray(a?.events) ? a.events : [];
                setEvents(list);
                setMore(list.length >= PAGE);
            })
            .catch((e) => !gone && setError(e as Error));
        return () => {
            gone = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, application, tick]); // `url` is built from these

    async function older() {
        const last = events?.at(-1);
        if (!last) return;
        setLoadingMore(true);
        setMoreError("");
        try {
            const a = await api<{ events?: ActivityEvent[] }>(url(last.id));
            const list = Array.isArray(a?.events) ? a.events : [];
            setEvents((prev) => [...(prev ?? []), ...list.filter((x) => !(prev ?? []).some((p) => p.id === x.id))]);
            setMore(list.length >= PAGE);
        } catch (e) {
            setMoreError(securityError(e));
        } finally {
            setLoadingMore(false);
        }
    }

    const setFilter = (patch: Record<string, string>) => {
        const next: Record<string, string> = { application, kind, person, ...patch };
        const qs = new URLSearchParams(Object.entries(next).filter(([, v]) => v)).toString();
        go(`${sec.activity(id)}${qs ? `?${qs}` : ""}`);
    };
    const people = useMemo(() => [...new Set((events ?? []).map((e) => e.actor?.name ?? "").filter(Boolean))].sort((a, b) => a.localeCompare(b)), [events]);
    const shown = (events ?? []).filter((e) => (!kind || kindOf(e.action) === kind) && (!person || e.actor?.name === person));
    const anyFilter = !!(application || kind || person);
    const appName = (appId?: string | null) => (appId ? apps.list.find((a) => a.id === appId)?.name : undefined);

    const select = (key: "application" | "kind" | "person", label: string, value: string, options: Array<[string, string]>, help?: string) => (
        <div className="field">
            <FieldHelp htmlFor={`sa-act-${key}`} label={label} help={help} />
            <select id={`sa-act-${key}`} className="input" value={value} onChange={(e) => setFilter({ [key]: e.target.value })}>
                <option value="">{key === "person" ? "Anyone" : "Any"}</option>
                {options.map(([v, l]) => (
                    <option key={v} value={v}>
                        {l}
                    </option>
                ))}
                {/* A filter from a shared address whose value is not among the options still shows what it is. */}
                {value && !options.some(([v]) => v === value) && <option value={value}>{key === "application" ? "An application no longer listed" : value}</option>}
            </select>
        </div>
    );

    const content = () => {
        if (error) return <ErrorState error={friendlyError(error.message)} onRetry={() => setTick((t) => t + 1)} />;
        if (!events) return <ListSkeleton rows={5} />;
        if (!events.length && !anyFilter)
            return (
                <div className="card">
                    <EmptyState icon={History} title="No activity yet">
                        Registering an application, recording an authorization, starting an assessment, changing a finding and exporting a report are all listed here, with who did it and when.
                    </EmptyState>
                </div>
            );
        return (
            <>
                {shown.length === 0 ? (
                    <div className="card">
                        <EmptyState icon={Search} title="Nothing matches these filters" actions={<Button onClick={() => go(sec.activity(id))}>Clear filters</Button>}>
                            {more ? "Older events are not loaded yet; show older ones to look further back." : undefined}
                        </EmptyState>
                    </div>
                ) : (
                    <ol className="card list divided" data-testid="sec-activity" aria-label="Security activity, newest first">
                        {shown.map((e) => {
                            const link = linkOf(id, e);
                            const app = appName(e.applicationId);
                            return (
                                <li key={e.id}>
                                    <div className="list-row" style={{ cursor: "default" }}>
                                        <span className="main">
                                            <span className="title" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
                                                {e.summary}
                                            </span>
                                            <span className="meta sec-list-cols">
                                                <span>{e.actor?.name || "Someone"}</span>
                                                <time dateTime={e.at}>
                                                    {when(e.at)} ({relativeTime(e.at)})
                                                </time>
                                                {app && !application && <span>{app}</span>}
                                                {link && <a href={link.href}>{link.label}</a>}
                                            </span>
                                        </span>
                                        <span className="tail">
                                            <Badge tone="neutral">{kindLabel(kindOf(e.action))}</Badge>
                                        </span>
                                    </div>
                                </li>
                            );
                        })}
                    </ol>
                )}
                {moreError && (
                    <Callout tone="danger" title="We couldn’t load older events">
                        {moreError}
                    </Callout>
                )}
                {more && (
                    <div className="row">
                        <Button icon={ChevronDown} loading={loadingMore} onClick={() => void older()} tip={`Loads the ${PAGE} events before the oldest one shown.`}>
                            Show older events
                        </Button>
                    </div>
                )}
            </>
        );
    };

    return (
        <SecurityLayout
            id={id}
            active="activity"
            title="Activity"
            subtitle={
                <>
                    Who did what in this project’s security work, and when. Newest first.{" "}
                    <BadgeKey label="the kinds in this list" entries={[...ACTIVITY_KINDS.filter((k) => shown.some((e) => kindOf(e.action) === k.key)).map((k) => ({ word: k.label, text: k.help })), shown.some((e) => kindOf(e.action) === "other") && { word: "Other", text: OTHER_HELP }]} />
                </>
            }
        >
            <div className="stack">
                <form className="card card-pad" role="search" aria-label="Filter activity" onSubmit={(e) => e.preventDefault()}>
                    <div className="sec-filters">
                        {select("application", "Application", application, apps.list.map((a) => [a.id, a.name]))}
                        {select("kind", "What", kind, ACTIVITY_KINDS.map((k) => [k.key, k.label]), "The kind of change. Settings and upkeep covers the testing type, notifications, backups and restores, and old assessments removed after the retention period.")}
                        {select("person", "Who", person, people.map((p) => [p, p]), "The people in the events loaded so far. Show older events to find someone who has not acted lately.")}
                    </div>
                    <div className="row" style={{ marginTop: 16 }}>
                        {anyFilter && (
                            <Button type="button" variant="ghost" onClick={() => go(sec.activity(id))}>
                                Clear filters
                            </Button>
                        )}
                        {events && (
                            <span className="t-meta" role="status">
                                {kind || person ? `${shown.length} of ${events.length} loaded event${events.length === 1 ? "" : "s"}` : `${events.length} event${events.length === 1 ? "" : "s"}${more ? " so far" : ""}`}
                            </span>
                        )}
                        <span className="hint" style={{ flexBasis: "100%" }}>
                            The trail is kept when an application is deleted. Summaries never contain secrets or the approver’s email address. The same events are listed in the platform’s Activity.
                        </span>
                    </div>
                </form>
                {content()}
            </div>
        </SecurityLayout>
    );
}
