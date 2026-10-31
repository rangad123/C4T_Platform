/**
 * The job page's "a person is needed" pause for phone explorations (engine/mobile/explore/signin.ts PersonGate), kept in the job's own events so
 * it works when the job runs in a separate worker process:
 *
 *   1. the exploration adds `mobile_sign_in_waiting` (data: requestId, kind, deadline, screen) and polls for an answer;
 *   2. the job page shows "Enter the code on the phone, then choose Continue" with Continue and "Go on without signing in";
 *   3. POST /api/projects/:id/jobs/:jobId/phone-sign-in adds `mobile_sign_in_answer` (data: requestId, choice) for the open question;
 *   4. the exploration reads it and goes on. No answer by the deadline: it adds the answer `timeout` itself and goes on without signing in.
 *
 * Only one question is open at a time per job; an answer to a question that is closed (answered, timed out) is refused.
 */
import { randomUUID } from "node:crypto";
import type { PersonAnswer, PersonGate, PersonQuestion, PersonQuestionKind } from "../engine/mobile/explore/signin.js";
import type { Db } from "./db.js";
import { HttpError } from "./http-error.js";
import type { Repo } from "./repo.js";

export const WAITING_KIND = "mobile_sign_in_waiting";
export const ANSWER_KIND = "mobile_sign_in_answer";

export interface OpenQuestion {
    requestId: string;
    kind: PersonQuestionKind;
    message: string;
    deadline: string;
    screen?: string;
}

type EventRow = { id: number; kind: string; message: string; data_json: string | null };

const minutes = (ms: number) => {
    const m = Math.max(1, Math.round(ms / 60_000));
    return `${m} minute${m === 1 ? "" : "s"}`;
};

const parse = (s: string | null): Record<string, unknown> => {
    try {
        const v = s ? JSON.parse(s) : null;
        return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    } catch {
        return {};
    }
};

/** The question a person can still answer for this job, or undefined. */
export function openQuestion(db: Db, jobId: string, now = Date.now()): OpenQuestion | undefined {
    const rows = db.all<EventRow>("SELECT id, kind, message, data_json FROM agent_events WHERE job_id = ? AND kind IN (?, ?) ORDER BY id DESC LIMIT 40", jobId, WAITING_KIND, ANSWER_KIND);
    const answered = new Set(rows.filter((r) => r.kind === ANSWER_KIND).map((r) => String(parse(r.data_json).requestId ?? "")));
    const waiting = rows.find((r) => r.kind === WAITING_KIND);
    if (!waiting) return undefined;
    const d = parse(waiting.data_json);
    const requestId = String(d.requestId ?? "");
    if (!requestId || answered.has(requestId)) return undefined;
    const deadline = String(d.deadline ?? "");
    if (!deadline || Date.parse(deadline) < now) return undefined;
    const kind = (["code", "captcha", "signed-out"] as const).find((k) => k === d.kind) ?? "code";
    return { requestId, kind, message: waiting.message, deadline, ...(typeof d.screen === "string" ? { screen: d.screen } : {}) };
}

/** The answer a person gave to this question, if any. */
function answerOf(db: Db, jobId: string, requestId: string): PersonAnswer | undefined {
    const rows = db.all<EventRow>("SELECT id, kind, message, data_json FROM agent_events WHERE job_id = ? AND kind = ? ORDER BY id DESC LIMIT 20", jobId, ANSWER_KIND);
    for (const r of rows) {
        const d = parse(r.data_json);
        if (d.requestId === requestId && (d.choice === "continue" || d.choice === "skip" || d.choice === "timeout")) return d.choice;
    }
    return undefined;
}

const CHOICE_WORDS: Record<"continue" | "skip", string> = {
    continue: "A person chose Continue: the AI looks at the phone again.",
    skip: "A person chose to go on without signing in.",
};

/** Records a person's answer to the open question. 409 when there is none to answer. */
export function answerQuestion(repo: Repo, jobId: string, choice: "continue" | "skip", who?: string): OpenQuestion {
    const q = openQuestion(repo.db, jobId);
    if (!q) throw new HttpError(409, "The exploration is not waiting for a person any more. It may have gone on already: look at its latest steps.");
    repo.addEvent(jobId, { stage: "discovery", kind: ANSWER_KIND, message: CHOICE_WORDS[choice], data: { requestId: q.requestId, choice, ...(who ? { by: who.slice(0, 80) } : {}) } });
    return q;
}

export interface GateOptions {
    pollMs?: number;
    now?: () => number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
        const t = setTimeout(done, ms);
        function done() {
            clearTimeout(t);
            signal?.removeEventListener("abort", done);
            resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
    });

/** A gate that asks through this job's events (the job page answers through the route). */
export function jobPersonGate(repo: Repo, jobId: string, o: GateOptions = {}): PersonGate {
    const now = o.now ?? Date.now;
    const pollMs = o.pollMs ?? 1000;
    return {
        async ask(q: PersonQuestion, signal?: AbortSignal): Promise<PersonAnswer> {
            const requestId = randomUUID();
            const deadline = new Date(now() + q.timeoutMs).toISOString();
            repo.addEvent(jobId, { stage: "discovery", kind: WAITING_KIND, level: "warn", message: q.message, data: { requestId, kind: q.kind, deadline, timeoutMs: q.timeoutMs, ...(q.screen ? { screen: q.screen.slice(0, 60) } : {}) } });
            while (true) {
                if (signal?.aborted) return "stopped";
                const a = answerOf(repo.db, jobId, requestId);
                if (a === "continue" || a === "skip") return a;
                if (a === "timeout") return "timeout";
                if (now() >= Date.parse(deadline)) {
                    repo.addEvent(jobId, { stage: "discovery", kind: ANSWER_KIND, level: "warn", message: `No one answered within ${minutes(q.timeoutMs)}, so the AI goes on without signing in.`, data: { requestId, choice: "timeout" } });
                    return "timeout";
                }
                await sleep(pollMs, signal);
            }
        },
    };
}
