/**
 * Signing in to an app during a phone exploration, without the AI choosing what to type:
 *
 *  - `readAuthScreen` says what a screen asks for: a user name and password, only an e-mail or phone first ("identifier", the password comes on
 *    the next screen), a one-time code, a captcha, or nothing.
 *  - `signInOnPhone` fills the screen from the project's test account through the device session: it types only the `{{credentials.*}}`
 *    placeholders (the session puts the real values in on the machine that owns the phone and never returns them), taps the sign-in button
 *    (never anything that reads as log out, pay, delete or send: explore/safety.ts judges the tap), and follows the app to the next screen,
 *    for at most a few screens.
 *  - A one-time code or a captcha cannot be answered by the platform: the exploration pauses and asks a person on the job page ("Enter the code on
 *    the phone, then choose Continue") through a `PersonGate`, with a time limit. Without a person to ask, it says so and goes on without signing in.
 *  - "Already signed in on this phone" (phone-settings.ts) keeps the app's data; if the app still asks to sign in, the person is asked to sign in
 *    on the phone by hand rather than the AI guessing.
 *
 * The session stays signed in for the rest of the exploration because nothing here, or in the explorer, clears the app's data, and
 * the explorer never taps log out (safety.ts). What was done is returned as steps with placeholders, for the explorer to record.
 */
import type { DeviceAction, DeviceSession, ScreenElement, ScreenSnapshot } from "../device/types.js";
import { elementWords, judgeAction, labelOf } from "./safety.js";
import { PASSWORD_PLACEHOLDER, USERNAME_PLACEHOLDER } from "./types.js";

// ── asking a person ─────────────────────────────────────────────────────────

export type PersonQuestionKind = "code" | "captcha" | "signed-out";

export interface PersonQuestion {
    kind: PersonQuestionKind;
    /** The sentence the job page shows, for example "Enter the code on the phone, then choose Continue." */
    message: string;
    /** How long to wait for an answer. */
    timeoutMs: number;
    /** The screen's title, for the page. */
    screen?: string;
}

/** continue: the person did it on the phone; skip: go on without signing in; timeout: nobody answered in time; stopped: the job was stopped. */
export type PersonAnswer = "continue" | "skip" | "timeout" | "stopped";

/** Pauses a job until a person answers on the job page (platform/phone-person-gate.ts). Absent: nobody can be asked (the explorer goes on). */
export interface PersonGate {
    ask(q: PersonQuestion, signal?: AbortSignal): Promise<PersonAnswer>;
}

/** Five minutes: long enough to read a text message, short enough that a forgotten exploration does not hold the phone for long. */
export const PERSON_WAIT_MS = 5 * 60_000;

/** "1 minute", "5 minutes". */
export const minutesWords = (ms: number): string => {
    const m = Math.max(1, Math.round(ms / 60_000));
    return `${m} minute${m === 1 ? "" : "s"}`;
};

export const PERSON_MESSAGES: Record<PersonQuestionKind, string> = {
    code: "The app asks for a one-time code. Enter the code on the phone, then choose Continue.",
    captcha: "The app shows a check that only a person can answer (a captcha). Answer it on the phone, then choose Continue.",
    "signed-out": "The app asks to sign in although “Already signed in on this phone” is on. Sign in on the phone by hand, then choose Continue.",
};

// ── what a screen asks for ──────────────────────────────────────────────────

export type AuthScreen =
    | { kind: "none" }
    | { kind: "password"; user?: ScreenElement; password: ScreenElement; submit?: ScreenElement }
    | { kind: "identifier"; field: ScreenElement; submit?: ScreenElement }
    | { kind: "code"; fields: ScreenElement[] }
    | { kind: "captcha" };

const CAPTCHA = /(captcha|recaptcha|i'?m not a robot|not a robot|verify (that )?you('| a)re (a )?human|are you a robot|security puzzle|solve (the|this) puzzle)/i;
const CODE_FIELD = /(\bcode\b|\botp\b|one.?time|verification|verify|passcode|\bpin\b|2fa|two.?factor|2.?step|security code|sms)/i;
const CODE_SCREEN = /(enter (the|your)? ?(\d+.?digit )?code|we (sent|texted|emailed) (you )?(a|the)? ?code|verification code|one.?time (pass)?code|two.?step|2.?step verification|two.?factor|check your (phone|email|messages) for (a|the) code)/i;
const SIGN_IN_WORDS = /(sign ?in|log ?in|welcome back|anmelden|connexion|se connecter|iniciar sesi[oó]n|entrar|accedi)/i;
const IDENTIFIER_FIELD = /(e-?mail|phone|mobile|user ?name|user|login|account|benutzer|correo|t[eé]l[eé]phone)/i;
const SUBMIT = /^(sign ?in|log ?in|login|continue|next|submit|done|verify|ok|anmelden|weiter|connexion|se connecter|continuer|suivant|iniciar sesi[oó]n|entrar|continuar|siguiente|accedi|avanti)$/i;
const NOT_SUBMIT = /(forgot|reset|show|hide|sign ?up|register|create|join|new account|help|google|facebook|apple|microsoft|linkedin|with |terms|privacy|cancel|back)/i;
const LOG_OUT = /(log ?out|sign ?out|abmelden|d[eé]connexion|cerrar sesi[oó]n|esci)/i;

const words = (e: ScreenElement) => `${e.text} ${e.desc} ${e.id.replace(/[_\-.]+/g, " ")}`.trim();
const below = (a: ScreenElement, b: ScreenElement) => a.bounds[1] >= b.bounds[1] - 4;

/** The button that sends a sign-in form: labelled like one, below the last field, never "Forgot password" or "Sign up", never log out. */
function submitOf(snap: ScreenSnapshot, after: ScreenElement): ScreenElement | undefined {
    const buttons = snap.elements.filter((e) => e.clickable && e.enabled && !e.editable && !e.checkable && !LOG_OUT.test(words(e)));
    const named = buttons.filter((e) => SUBMIT.test((e.text || e.desc).trim()) && below(e, after));
    if (named.length) return named[0];
    // A button whose id says it signs in (login_button) when its text is an icon or empty.
    const byId = buttons.find((e) => /(sign.?in|log.?in|login|submit|continue|next)/i.test(e.id) && !NOT_SUBMIT.test(words(e)) && below(e, after));
    if (byId) return byId;
    return buttons.find((e) => below(e, after) && (e.cls === "Button" || /Button$/.test(e.cls)) && !NOT_SUBMIT.test(words(e)) && (e.text || e.desc).trim().length > 0);
}

/** What the screen asks for. Captchas first (a sign-in form with a captcha needs a person too), then codes, passwords, an e-mail or phone alone. */
export function readAuthScreen(snap: ScreenSnapshot): AuthScreen {
    if (snap.outsideApp && !snap.elements.some((e) => e.editable)) return { kind: "none" };
    const all = snap.elements;
    if (all.some((e) => CAPTCHA.test(words(e)))) return { kind: "captcha" };
    const editable = all.filter((e) => e.editable && e.enabled);
    const password = editable.find((e) => e.password);
    if (!password && editable.length) {
        const fields = editable.filter((e) => CODE_FIELD.test(words(e)));
        const screenSays = all.some((e) => !e.editable && CODE_SCREEN.test(`${e.text} ${e.desc}`));
        // One box per digit: four to eight narrow fields side by side.
        const narrow = editable.filter((e) => e.bounds[2] - e.bounds[0] > 0 && e.bounds[2] - e.bounds[0] < snap.width * 0.16);
        const row = narrow.length >= 4 && narrow.length <= 8 && narrow.every((e) => Math.abs(e.bounds[1] - narrow[0]!.bounds[1]) < 12);
        if (fields.length || (screenSays && editable.length <= 8) || row) return { kind: "code", fields: fields.length ? fields : row ? narrow : editable.slice(0, 1) };
    }
    if (password) {
        const at = all.indexOf(password);
        let user: ScreenElement | undefined;
        for (let i = at - 1; i >= 0; i--) if (all[i]!.editable && !all[i]!.password) {
            user = all[i];
            break;
        }
        const submit = submitOf(snap, password);
        return { kind: "password", ...(user ? { user } : {}), password, ...(submit ? { submit } : {}) };
    }
    // An e-mail or phone first: only on a screen that reads as signing in, with exactly one such field.
    const signingIn = all.some((e) => !e.editable && SIGN_IN_WORDS.test(`${e.text} ${e.desc}`));
    const ids = editable.filter((e) => IDENTIFIER_FIELD.test(words(e)));
    if (signingIn && ids.length === 1 && editable.length <= 2) {
        const submit = submitOf(snap, ids[0]!);
        return { kind: "identifier", field: ids[0]!, ...(submit ? { submit } : {}) };
    }
    return { kind: "none" };
}

/** Is this a screen the sign-in helper should handle? */
export const asksToSignIn = (snap: ScreenSnapshot): boolean => readAuthScreen(snap).kind !== "none";

// ── signing in ──────────────────────────────────────────────────────────────

export interface SignInStep {
    action: DeviceAction;
    /** The element's words, for the recorded test and the events ("Typed the user name into “Email”"). */
    label: string;
    element?: ScreenElement;
    /** The screen the step was done on. */
    on: ScreenSnapshot;
}

export type SignInStatus =
    /** The sign-in screens were filled and the app moved on. */
    | "signed-in"
    /** The app stayed on its sign-in screen after the details were sent. */
    | "rejected"
    /** A person did the code or captcha (or signed in) on the phone and chose Continue; the app moved on. */
    | "person-done"
    /** A person chose to go on without signing in, or the screen was still there after Continue. */
    | "person-skipped"
    /** Nobody answered in time, or nobody can be asked (no person gate). */
    | "no-answer"
    /** The screen asks for details the project did not give. */
    | "no-details"
    /** Not a sign-in screen. */
    | "not-sign-in"
    /** The phone did not do what was asked, or the job was stopped. */
    | "failed";

export interface SignInOutcome {
    status: SignInStatus;
    /** Plain sentence for the job's events. Never a value that was typed. */
    message: string;
    /** The screen after. */
    snapshot: ScreenSnapshot;
    /** What was done, with placeholders only. */
    steps: SignInStep[];
    /** The kind of question a person was asked, when one was. */
    asked?: PersonQuestionKind;
}

export interface SignInOptions {
    session: DeviceSession;
    snap: ScreenSnapshot;
    /** Which details the project gave. Only whether they exist: the values stay with the device session. */
    details: { username: boolean; password: boolean };
    /** "Already signed in on this phone" is on. */
    keepSignedIn?: boolean;
    /** Asks a person on the job page; absent when nobody can be asked. */
    ask?: PersonGate;
    signal?: AbortSignal;
    /** How long a person has to answer (default 5 minutes). */
    waitMs?: number;
    /** Screens followed at most (an e-mail first, then the password, then a code): default 4. */
    maxScreens?: number;
    /** "Include tests that change data" (sign-in buttons are allowed either way; this only reaches safety.ts for other words). */
    allowDataChanges?: boolean;
}

const sameElement = (a: ScreenElement, b: ScreenElement) => a.cls === b.cls && a.id === b.id && (a.id !== "" || (a.bounds.join() === b.bounds.join()));

/** The element in a newer snapshot that is the same as `el` (same class and id, or the same place when it has no id). */
function refind(snap: ScreenSnapshot, el: ScreenElement): ScreenElement | undefined {
    return snap.elements.find((e) => sameElement(e, el)) ?? snap.elements.find((e) => e.cls === el.cls && e.bounds.join() === el.bounds.join());
}

const title = (snap: ScreenSnapshot): string => {
    const t = snap.elements.find((e) => !e.clickable && !e.editable && e.text.trim().length >= 2 && e.text.trim().length <= 40);
    return t ? labelOf(t) : "this screen";
};

/** Fills the sign-in screen(s) in front of the explorer from the project's test account, or asks a person. Never throws for what the app does. */
export async function signInOnPhone(o: SignInOptions): Promise<SignInOutcome> {
    const steps: SignInStep[] = [];
    let snap = o.snap;
    let first = readAuthScreen(snap);
    if (first.kind === "none") return { status: "not-sign-in", message: "This screen does not ask to sign in.", snapshot: snap, steps };
    const maxScreens = o.maxScreens ?? 4;
    let typedSomething = false;

    const act = async (action: DeviceAction, label: string, element?: ScreenElement): Promise<ScreenSnapshot | string> => {
        if (o.signal?.aborted) return "The exploration was stopped.";
        const before = snap;
        const r = await o.session.act(action).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e), snapshot: undefined }));
        if (!r.ok) return r.error ?? "The phone could not do that.";
        steps.push({ action, label, ...(element ? { element } : {}), on: before });
        return r.snapshot ?? (await o.session.snapshot());
    };

    const askPerson = async (kind: PersonQuestionKind): Promise<SignInOutcome> => {
        const screen = title(snap);
        if (!o.ask) {
            const why = kind === "signed-out" ? "the app asks to sign in although “Already signed in on this phone” is on" : kind === "code" ? "the app asks for a one-time code" : "the app shows a captcha";
            return { status: "no-answer", message: `Did not sign in: ${why}, and no one can be asked during this exploration. The AI goes on with what it can reach.`, snapshot: snap, steps, asked: kind };
        }
        const answer = await o.ask.ask({ kind, message: PERSON_MESSAGES[kind], timeoutMs: o.waitMs ?? PERSON_WAIT_MS, screen }, o.signal);
        if (answer === "stopped") return { status: "failed", message: "The exploration was stopped while it waited for a person.", snapshot: snap, steps, asked: kind };
        if (answer === "timeout") return { status: "no-answer", message: `No one answered within ${minutesWords(o.waitMs ?? PERSON_WAIT_MS)}, so the AI goes on without signing in.`, snapshot: snap, steps, asked: kind };
        if (answer === "skip") return { status: "person-skipped", message: "A person chose to go on without signing in.", snapshot: snap, steps, asked: kind };
        const after = await o.session.snapshot().catch(() => snap);
        snap = after;
        const still = readAuthScreen(after);
        if (still.kind !== "none" && (still.kind === first.kind || still.kind === "code" || still.kind === "captcha")) {
            return { status: "person-skipped", message: "The sign-in screen was still showing after Continue, so the AI goes on without signing in.", snapshot: after, steps, asked: kind };
        }
        return { status: "person-done", message: kind === "signed-out" ? "Signed in by a person on the phone; the AI goes on signed in." : "A person answered on the phone; the AI goes on signed in.", snapshot: after, steps, asked: kind };
    };

    for (let round = 0; round < maxScreens; round++) {
        const screen: AuthScreen = round === 0 ? first : readAuthScreen(snap);
        if (round === 0) first = screen;
        if (screen.kind === "none") {
            return typedSomething
                ? { status: "signed-in", message: "Signed in with the project's test account.", snapshot: snap, steps }
                : { status: "not-sign-in", message: "This screen does not ask to sign in.", snapshot: snap, steps };
        }
        if (screen.kind === "code" || screen.kind === "captcha") return askPerson(screen.kind);
        if (o.keepSignedIn && !typedSomething && (!o.details.password || !o.details.username)) return askPerson("signed-out");
        const need = screen.kind === "identifier" ? o.details.username : o.details.password && (!("user" in screen && screen.user) || o.details.username);
        if (!need) {
            return { status: "no-details", message: `“${title(snap)}” asks for sign-in details and none were given, so the AI goes on with what it can reach.`, snapshot: snap, steps };
        }

        // Fill the fields, each found again in the newest screen (typing can move things).
        const fills: Array<[ScreenElement, string, string]> =
            screen.kind === "identifier" ? [[screen.field, USERNAME_PLACEHOLDER, "the user name"]] : [...(screen.user ? ([[screen.user, USERNAME_PLACEHOLDER, "the user name"]] as Array<[ScreenElement, string, string]>) : []), [screen.password, PASSWORD_PLACEHOLDER, "the password"]];
        for (const [el, text, what] of fills) {
            const now = refind(snap, el);
            if (!now) return { status: "failed", message: `The field for ${what} moved away before it could be filled.`, snapshot: snap, steps };
            const r = await act({ kind: "type", index: now.index, text, clear: true }, `Typed ${what} into “${labelOf(now)}”`, now);
            if (typeof r === "string") return { status: "failed", message: r, snapshot: snap, steps };
            snap = r;
            typedSomething = true;
        }
        if (snap.keyboard) {
            const r = await act({ kind: "hideKeyboard" }, "Closed the keyboard");
            if (typeof r !== "string") snap = r;
        }
        const submit = screen.submit ? refind(snap, screen.submit) : undefined;
        const last = refind(snap, screen.kind === "identifier" ? screen.field : screen.password);
        const button = submit ?? (last ? submitOf(snap, last) : undefined);
        if (!button) return { status: "failed", message: `Filled “${title(snap)}” but found no button that sends it.`, snapshot: snap, steps };
        // Never log out, pay, delete or send, whatever the button is called (safety.ts has the final word).
        const verdict = judgeAction({ kind: "tap", index: button.index }, snap, { allowDataChanges: o.allowDataChanges ?? false });
        if (!verdict.ok || LOG_OUT.test(elementWords(button))) return { status: "failed", message: verdict.ok ? `Did not tap “${labelOf(button)}”.` : verdict.message, snapshot: snap, steps };
        const before = readAuthScreen(snap).kind;
        const r = await act({ kind: "tap", index: button.index }, `Tapped “${labelOf(button)}”`, button);
        if (typeof r === "string") return { status: "failed", message: r, snapshot: snap, steps };
        snap = r;
        const next = readAuthScreen(snap);
        // The same kind of screen again (and not the password after an e-mail): the details were not accepted.
        if (next.kind === before && next.kind !== "none") return { status: "rejected", message: `The test account's details were not accepted on “${title(snap)}”. Check them under the exploration's Advanced options or Test accounts.`, snapshot: snap, steps };
    }
    return readAuthScreen(snap).kind === "none"
        ? { status: "signed-in", message: "Signed in with the project's test account.", snapshot: snap, steps }
        : { status: "failed", message: "The app kept asking for more sign-in screens than the AI follows.", snapshot: snap, steps };
}
