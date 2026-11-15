/**
 * Scheduled passive assessments of one application (src/security/routes/schedule.ts):
 *   GET /api/v1/security/applications/:appId/schedule   { schedule: null | ScheduleView }
 *   PUT /api/v1/security/applications/:appId/schedule   { cadence: { type: "daily", time } | { type: "weekly", weekday, time } | null }
 * A schedule only ever starts a passive assessment, in the name of the person who set it, while the authorization is current.
 */
import { CalendarClock, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { Button, Callout, Skeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { SEC, when, type AppRow } from "./security";

interface ScheduleView {
    cadence: { type: "daily"; time: string } | { type: "weekly"; weekday: number; time: string };
    enabled: boolean;
    words: string;
    nextRunAt: string | null;
    maker: string;
    lastRunAt: string | null;
    lastOutcome: "started" | "skipped" | "stopped" | "error" | null;
    lastNote: string | null;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
type Choice = "off" | "daily" | "weekly";

export function SchedulePanel({ app, canChange, authorized }: { app: AppRow; canChange: boolean; authorized: boolean }) {
    const got = useFetch<{ schedule: ScheduleView | null }>(`${SEC}/applications/${app.id}/schedule`);
    const s = got.data?.schedule ?? null;
    const [choice, setChoice] = useState<Choice>("off");
    const [time, setTime] = useState("02:00");
    const [weekday, setWeekday] = useState(1);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    useEffect(() => {
        if (!s) return;
        setChoice(s.enabled ? s.cadence.type : "off");
        setTime(s.cadence.time);
        if (s.cadence.type === "weekly") setWeekday(s.cadence.weekday);
    }, [s?.enabled, s?.cadence.type, s?.cadence.time]);

    const save = async () => {
        setBusy(true);
        setNote(null);
        try {
            const cadence = choice === "off" ? null : choice === "daily" ? { type: "daily", time } : { type: "weekly", weekday, time };
            await api(`${SEC}/applications/${app.id}/schedule`, { method: "PUT", body: { cadence } });
            setNote({ tone: "success", text: choice === "off" ? "The schedule is off." : "Saved. Scheduled assessments run in your name." });
            await got.reload();
        } catch (e) {
            setNote({ tone: "danger", text: describeApiError(e) });
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className="card card-pad stack-sm" aria-labelledby="sa-schedule-h" data-testid="sa-schedule">
            <div className="row" style={{ gap: 8 }}>
                <CalendarClock size={18} aria-hidden />
                <h2 className="t-section" id="sa-schedule-h">
                    Schedule
                </h2>
            </div>
            <p className="t-secondary">A scheduled assessment is always passive, the same as one started here. It runs only while the authorization is current, in the name of the person who set the schedule.</p>
            {got.loading && !got.data ? (
                <Skeleton h={60} />
            ) : (
                <>
                    <p data-testid="sa-schedule-words">
                        <b>{s?.enabled ? s.words : "Off"}</b>
                        {s?.enabled && s.nextRunAt ? <span className="t-meta"> · next {when(s.nextRunAt)}, set by {s.maker}</span> : null}
                    </p>
                    {s?.lastOutcome && s.lastRunAt && (
                        <p className="t-meta" data-testid="sa-schedule-last">
                            Last time ({when(s.lastRunAt)}): {s.lastOutcome === "started" ? "an assessment started" : s.lastNote ?? s.lastOutcome}
                        </p>
                    )}
                    {canChange && (
                        <div className="stack-sm">
                            <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
                                <div className="field">
                                    <label htmlFor="sa-schedule-choice">How often</label>
                                    <select id="sa-schedule-choice" className="input" value={choice} onChange={(e) => setChoice(e.target.value as Choice)}>
                                        <option value="off">Off</option>
                                        <option value="daily">Every day</option>
                                        <option value="weekly">Every week</option>
                                    </select>
                                </div>
                                {choice === "weekly" && (
                                    <div className="field">
                                        <label htmlFor="sa-schedule-day">Day</label>
                                        <select id="sa-schedule-day" className="input" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                                            {WEEKDAYS.map((d, i) => (
                                                <option key={d} value={i}>
                                                    {d}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                )}
                                {choice !== "off" && (
                                    <div className="field">
                                        <label htmlFor="sa-schedule-time">Time (UTC)</label>
                                        <input id="sa-schedule-time" className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ maxWidth: 160 }} />
                                    </div>
                                )}
                            </div>
                            {choice !== "off" && !authorized && <Callout tone="warning">Record a current authorization first: a schedule can only be switched on while there is one.</Callout>}
                            {note && <Callout tone={note.tone}>{note.text}</Callout>}
                            <div>
                                <Button icon={Save} loading={busy} disabled={choice !== "off" && !authorized} onClick={() => void save()}>
                                    Save schedule
                                </Button>
                            </div>
                        </div>
                    )}
                </>
            )}
        </section>
    );
}
