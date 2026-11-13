import { useEffect, useSyncExternalStore } from "react";
import { api } from "../../api";
import type { Tone } from "../../lib/labels";

/**
 * AI keys (docs/features/ai-keys.md): two kinds only. A personal key belongs to one person, who alone sees and uses it. An organisational
 * key is Crowd4Test's: admins add it and assign it to particular admins or sub-admins, who may then use it. Each person chooses ONE key, and
 * all the AI work they start, in any project, uses it. Projects have no AI setting. No answer ever carries a key, only its last four characters.
 */
export type KeyKind = "personal" | "organisational";
export type KeyStatusWord = "untested" | "working" | "failed";

export interface AiProviderChoice {
    id: string;
    name: string;
    defaultModel: string;
    needsAddress: boolean;
}

/** One key as the server shows it (GET /api/me/ai, GET /api/admin/ai-keys). */
export interface KeyView {
    id: string;
    kind: KeyKind;
    label: string;
    provider: string;
    providerWords: string;
    model: string;
    fastModel: string | null;
    baseUrl: string | null;
    keyHint: string;
    status: KeyStatusWord;
    statusNote: string | null;
    lastValidatedAt: string | null;
    chosen: boolean;
}

/** GET /api/me/ai. */
export interface MyAiAnswer {
    chosen: KeyView | null;
    /** The exact sentence to show when the chosen key cannot be used now (none chosen, removed, unassigned, failing); null when it can. */
    problem: string | null;
    personal: KeyView[];
    /** Organisational keys assigned to this person. */
    organisational: KeyView[];
    canManageOrganisational: boolean;
    providers?: AiProviderChoice[];
    /** Open mode only (no accounts): AI uses the server's own key. */
    openServer?: { configured: boolean; provider: string; model: string } | null;
}

export interface Assignee {
    id: string;
    name: string;
    email?: string;
}
/** GET /api/admin/ai-keys. */
export interface AdminKeysAnswer {
    keys: Array<KeyView & { assignees: Assignee[] }>;
    /** Admins and sub-admins who may be assigned a key. */
    people: Array<Assignee & { role: string }>;
    providers?: AiProviderChoice[];
}

export interface KeyTestAnswer {
    ok: boolean;
    message: string;
    latencyMs?: number;
}

export const STATUS_WORDS: Record<KeyStatusWord, { label: string; tone: Tone; tip: string }> = {
    untested: { label: "Not tested yet", tone: "neutral", tip: "Nobody has tested this key since it was saved." },
    working: { label: "Working", tone: "success", tip: "The last test or use of this key worked." },
    failed: { label: "Not working", tone: "danger", tip: "The last test or use of this key failed." },
};

export const KIND_WORDS: Record<KeyKind, { label: string; tip: string }> = {
    personal: { label: "Your key", tip: "Your own key. Only you see it and use it." },
    organisational: { label: "Organisational", tip: "Crowd4Test’s key, assigned to you by an admin. You may use it; only admins change it." },
};

/** Said when a person has no usable key (the server's own sentence is shown when it gives one). */
export const NO_AI_KEY = "You have no AI key. Add your own key in Settings, AI keys, or ask an admin to assign an organisational key.";

/** A server without accounts, whose own key is missing. */
export const OPEN_SERVER_NO_KEY = "This server has no AI key of its own. Add one to its .env file and restart it.";

/** Used only when an older server's answer has no provider list. */
export const FALLBACK_PROVIDERS: AiProviderChoice[] = [
    { id: "anthropic", name: "Anthropic", defaultModel: "claude-sonnet-5-5", needsAddress: false },
    { id: "openai", name: "OpenAI", defaultModel: "gpt-5.4", needsAddress: false },
    { id: "google", name: "Google", defaultModel: "gemini-2.5-flash", needsAddress: false },
    { id: "openai-compatible", name: "Custom endpoint", defaultModel: "llama3.1", needsAddress: true },
];

// ── the person's AI, one answer for the whole page ──────────────────────────

type Snap = { data?: MyAiAnswer; error?: Error };
let snap: Snap = {};
let users = 0;
let generation = 0;
const listeners = new Set<() => void>();
const publish = (next: Snap) => {
    snap = next;
    for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
};

/** Ask the server again (after adding, choosing, testing or removing a key, and when the window gets the focus). */
export async function reloadMyAi(): Promise<void> {
    const mine = ++generation;
    try {
        const data = await api<MyAiAnswer>("/me/ai");
        if (mine === generation) publish({ data });
    } catch (e) {
        if (mine === generation) publish({ data: snap.data, error: e instanceof Error ? e : new Error(String(e)) });
    }
}
const onFocus = () => void reloadMyAi();

/** Every place that shows the person's AI (Settings, the side bar sign, every AI start) reads this one answer, so they never disagree. */
export function useMyAi(): { data: MyAiAnswer | undefined; error: Error | undefined; loading: boolean; reload: () => Promise<void> } {
    const s = useSyncExternalStore(subscribe, () => snap);
    useEffect(() => {
        users++;
        if (users === 1) window.addEventListener("focus", onFocus);
        // A place that opens asks again, so a key added, chosen or unassigned elsewhere shows without reloading the page.
        void reloadMyAi();
        return () => {
            users--;
            if (users > 0) return;
            window.removeEventListener("focus", onFocus);
            generation++;
            snap = {};
        };
    }, []);
    return { data: s.data, error: s.data ? undefined : s.error, loading: s.data === undefined && s.error === undefined, reload: reloadMyAi };
}

/** Can this person's AI work start now? Their chosen key is usable, or (open mode) the server has a key. Unknown until the answer is in. */
export function aiReadyOf(a: MyAiAnswer | undefined): boolean | undefined {
    if (!a) return undefined;
    if (a.openServer) return a.openServer.configured;
    return Boolean(a.chosen) && !a.problem;
}

/** The sentence to show where AI work cannot start (the server's own words when it gives them). */
export function aiProblemOf(a: MyAiAnswer | undefined): string {
    if (a?.openServer && !a.openServer.configured) return OPEN_SERVER_NO_KEY;
    return a?.problem ?? NO_AI_KEY;
}

/** Whether the person's AI is ready, for start controls. Until the answer is in, nothing is blocked (the server decides at the click). */
export function useAiReady(): boolean {
    const { data } = useMyAi();
    return aiReadyOf(data) ?? true;
}

/** Why the person's AI work cannot start (the server's sentence), or undefined when it can or is not known yet. For start controls' tips. */
export function useAiBlock(): string | undefined {
    const { data } = useMyAi();
    return aiReadyOf(data) === false ? aiProblemOf(data) : undefined;
}
