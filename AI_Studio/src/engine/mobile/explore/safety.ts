/**
 * The safety filter of phone exploration. It is code, not prompt: whatever the AI model was told and whatever a screen says, an action is
 * checked here before it reaches the phone, and a refused action is recorded in plain words.
 *
 * What it refuses:
 *  - tapping something that looks like paying, buying, deleting, sending, calling or erasing (the word table below, English first);
 *  - any tap on a screen that itself looks like a payment or a deletion, except the ways out (cancel, back, close...);
 *  - tapping something that would change the app's data, unless the project allows tests that change data;
 *  - anything but "back", "launch" and permission-dialog buttons while the phone shows something outside the app;
 *  - typing card details, and typing into a field the platform cannot see;
 *  - the same action over and over (loop guard), and going on when nothing changes (stall guard).
 *
 * The word table is one place and easy to extend: add a word to the right list. A word ending in `*` matches longer words that start with it
 * ("delet*" matches delete, deleting, deletion); every other word must stand alone.
 */
import type { DeviceAction, ScreenElement, ScreenSnapshot } from "../device/types.js";
import type { SkipNote } from "./types.js";
import { cleanAppText } from "./text.js";

type Why = SkipNote["why"];

/** Words on an element that make tapping it destructive, paid or irreversible, whatever the project allows. */
export const FORBIDDEN_WORDS: Record<Forbidden, string[]> = {
    payment: [
        "pay*", "purchas*", "buy*", "check out", "checkout", "place order", "place your order", "order now", "confirm order", "subscri*", "upgrad*",
        "free trial", "donat*", "top up", "top-up", "add funds", "withdraw*", "transfer*", "wire money", "credit card", "debit card", "in-app purchase",
        // Other languages (not a full list: extend it when an app needs it).
        "bezahl*", "zahl*", "kauf*", "bestell*", "comprar", "compra*", "pagar", "pago*", "achet*", "paiement", "commander", "acquist*", "pagament*",
    ],
    destructive: [
        "delet*", "remov*", "eras*", "wipe*", "factory reset", "reset", "clear data", "clear all", "clear history", "uninstall*", "deactivat*", "close account",
        "terminat*", "destroy*", "sign out of all", "log out of all", "logout of all", "sign out everywhere", "log out everywhere",
        "losch*", "entfern*", "elimin*", "borrar", "borra*", "supprim*", "effac*", "cancellare", "apagar",
    ],
    sending: ["send*", "enviar", "envoyer", "senden", "sende*", "invia*", "transmit*", "broadcast*"],
    calling: ["call*", "dial*", "emergency", "sos", "llamar", "appeler", "anruf*", "chiama*", "notruf"],
    // Actions other people see, or that change who the signed-in person is connected to (R24: a real LinkedIn account was explored).
    social: [
        "like", "liked", "unlike", "react*", "celebrate", "love", "insightful", "funny", "curious", "upvot*", "downvot*", "vote", "dislike",
        "follow*", "unfollow*", "connect", "connect with*", "accept", "accept invitation", "ignore", "decline", "withdraw invitation", "endorse*",
        "repost*", "reshare*", "retweet*", "comment*", "reply*", "message", "messaging", "write a message", "dm", "easy apply", "apply now", "apply for*", "submit application",
        "mention*", "tag people", "block*", "unblock*", "report this*", "report post", "report comment", "report profile", "report user", "report abuse", "report spam", "mute*", "unmute*", "hide post", "not interested", "recommend*", "nominate*",
        "gefallt mir", "folgen", "vernetzen", "me gusta", "seguir", "conectar", "j'aime", "suivre", "se connecter avec",
    ],
};

/** Words that change the app's data. Refused unless the project switched on "Include tests that change data". */
export const DATA_CHANGING_WORDS: string[] = [
    "sav*", "submit*", "creat*", "register*", "sign up", "signup", "post", "publish*", "upload*", "invit*", "book*", "reserv*", "share*", "update", "confirm",
    "add new", "new note", "add note", "add task", "add contact", "add item", "add comment", "add address", "add card", "join",
    "registrar", "inscri*", "anmeld*", "speichern", "enregistrer", "guardar",
];

/** Words that sign out of the app (R24): refused, so the exploration and its tests stay signed in. */
export const SIGN_OUT_WORDS: string[] = ["log out", "logout", "log off", "logoff", "sign out", "signout", "sign off", "abmelden", "deconnexion", "se deconnecter", "cerrar sesion", "esci", "uitloggen"];

/** What a screen must show (in text that cannot be tapped) to count as a payment or deletion screen. Every tap but the ways out is refused there. */
const SCREEN_DANGER: Record<"payment" | "destructive", string[]> = {
    payment: ["pay*", "purchas*", "check out", "checkout", "place order", "credit card", "card number", "billing", "bezahl*", "zahlung", "pago*", "paiement"],
    destructive: ["delete account", "delete my account", "remove account", "close account", "deactivate account", "factory reset", "erase all*", "erase everything", "clear all data", "uninstall*", "konto loschen", "supprimer le compte"],
};

/** The ways out of a screen that looks dangerous: they are always fine to tap. */
const WAY_OUT = new RegExp(`^(${["cancel", "no", "not now", "no thanks", "back", "close", "dismiss", "navigate up", "up", "go back", "never mind", "keep", "stay", "abort", "abbrechen", "nein", "annuler", "non", "cancelar", "cerrar", "schliessen", "fermer"].join("|")})(?![\\p{L}\\p{N}])`, "iu");

/** Buttons of a system permission dialog. */
const DENY_BUTTON = /(?<![\p{L}\p{N}])(don'?t allow|do not allow|deny|not now|no thanks|never|cancel|ask me later)(?![\p{L}\p{N}])/iu;
const ALLOW_BUTTON = /(?<![\p{L}\p{N}])(allow|while using the app|only this time|ok|continue)(?![\p{L}\p{N}])/iu;

/** Fields that must never be typed into by a tool, whatever is typed. */
const NEVER_TYPE = /(card.?(number|no)|cvv|cvc|security code|iban|account number|routing|pin\b|ssn|social security|passport|otp|one.?time|verification code|sort code)/i;

// ── matching ────────────────────────────────────────────────────────────────

/** Lower case, diacritics removed, so "Löschen" and "loschen" are the same word. */
function plain(s: string): string {
    return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** `btn_delete_account` and `deleteAccount` read as words. */
function wordify(id: string): string {
    return id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ");
}

const compiled = new Map<string, RegExp>();
function matcher(words: readonly string[]): RegExp {
    const key = words.join("|");
    let re = compiled.get(key);
    if (!re) {
        const parts = words.map((w) => {
            const stem = w.endsWith("*");
            const body = plain(stem ? w.slice(0, -1) : w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
            return stem ? `${body}[\\p{L}\\p{N}]*` : body;
        });
        re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join("|")})(?![\\p{L}\\p{N}])`, "iu");
        compiled.set(key, re);
    }
    return re;
}

/** The words a person would read on an element, plus the words of its resource id. */
export function elementWords(e: Pick<ScreenElement, "text" | "desc" | "id">): string {
    return plain(`${e.text} ${e.desc} ${wordify(e.id)}`);
}

/** The label shown in plain messages: cleaned text, else the accessibility label, else the id. */
export function labelOf(e: Pick<ScreenElement, "text" | "desc" | "id" | "cls">): string {
    return cleanAppText(e.text || e.desc || wordify(e.id) || e.cls, 40);
}

export type Forbidden = "payment" | "destructive" | "sending" | "calling" | "social";

/** Which forbidden group (if any) a set of words belongs to. */
export function forbiddenGroup(words: string): Forbidden | undefined {
    const w = plain(words);
    for (const g of ["payment", "destructive", "sending", "calling", "social"] as const) if (matcher(FORBIDDEN_WORDS[g]).test(w)) return g;
    return undefined;
}

/** Does an element read as signing out (its words, as elementWords gives them)? */
export function signsOut(words: string): boolean {
    return matcher(SIGN_OUT_WORDS).test(plain(words));
}

export function changesData(words: string): boolean {
    return matcher(DATA_CHANGING_WORDS).test(plain(words));
}

/** Does the screen itself read as a payment or a deletion? Judged only from text that cannot be tapped and from the activity's name. */
export function screenDanger(snap: ScreenSnapshot): "payment" | "destructive" | undefined {
    const texts = snap.elements.filter((e) => !e.clickable && !e.editable).slice(0, 24).map((e) => `${e.text} ${e.desc}`);
    const activity = wordify((snap.activity ?? "").split(".").pop() ?? "");
    const hay = plain([...texts, activity].join(" \n "));
    for (const g of ["destructive", "payment"] as const) if (matcher(SCREEN_DANGER[g]).test(hay)) return g;
    return undefined;
}

const MESSAGE: Record<Forbidden, string> = {
    payment: "it looks like a payment or purchase",
    destructive: "it looks destructive",
    sending: "it looks like sending something",
    calling: "it looks like starting a call",
    social: "other people would see it (a like, follow, connection, comment, message or application)",
};
const WHY: Record<Forbidden, Why> = { payment: "payment", destructive: "destructive", sending: "sending", calling: "calling", social: "social" };

export type Verdict = { ok: true } | { ok: false; why: Why; message: string };
const refuse = (why: Why, message: string): Verdict => ({ ok: false, why, message });

export interface SafetyContext {
    /** "Include tests that change data" is on. */
    allowDataChanges: boolean;
}

/** A button of a permission dialog or other system dialog (not part of the app's own screen). */
export function dialogButtons(snap: ScreenSnapshot): { deny?: ScreenElement; allow?: ScreenElement } {
    const buttons = snap.elements.filter((e) => e.clickable && e.enabled);
    const deny = buttons.find((e) => DENY_BUTTON.test(`${e.text} ${e.desc}`));
    const allow = buttons.find((e) => !DENY_BUTTON.test(`${e.text} ${e.desc}`) && ALLOW_BUTTON.test(`${e.text} ${e.desc}`));
    return { ...(deny ? { deny } : {}), ...(allow ? { allow } : {}) };
}

/** Is this element one of the buttons of a dialog on an outside-the-app screen? */
function isDialogButton(e: ScreenElement): boolean {
    const t = `${e.text} ${e.desc}`;
    return e.clickable && (DENY_BUTTON.test(t) || ALLOW_BUTTON.test(t));
}

export function judgeAction(action: DeviceAction, snap: ScreenSnapshot, ctx: SafetyContext): Verdict {
    // Ways of moving that need no element.
    if (action.kind === "back" || action.kind === "hideKeyboard" || action.kind === "launch" || action.kind === "restart" || action.kind === "wait") return { ok: true };
    if (action.kind === "scroll") {
        if (snap.outsideApp) return refuse("outside-app", "Skipped scrolling because the phone is outside the app being tested");
        return { ok: true };
    }
    const el = snap.elements.find((e) => e.index === action.index);
    if (!el) return refuse("invalid", "That element is not on the screen any more");
    const label = labelOf(el);
    const words = elementWords(el);

    if (snap.outsideApp) {
        if (action.kind === "tap" && isDialogButton(el)) return { ok: true };
        return refuse("outside-app", `Skipped “${label}” because it is outside the app being tested`);
    }

    if (action.kind === "type") {
        if (!el.editable) return refuse("invalid", `Skipped typing into “${label}” because it is not a text field`);
        if (NEVER_TYPE.test(words) && !el.password) return refuse("invalid", `Skipped typing into “${label}” because card and identity details are never typed`);
        const danger = screenDanger(snap);
        if (danger) return refuse(danger === "payment" ? "payment" : "destructive", `Skipped typing into “${label}” because this screen ${danger === "payment" ? "looks like a payment" : "looks destructive"}`);
        return { ok: true };
    }
    if (action.kind === "longPress") return refuse("invalid", `Skipped pressing and holding “${label}” because tests cannot repeat it`);

    // A tap.
    const group = forbiddenGroup(words);
    if (group) return refuse(WHY[group], `Skipped “${label}” because ${MESSAGE[group]}`);
    // Signing out ends the signed-in session the exploration and its tests use (R24): never tapped, whoever chose it.
    if (matcher(SIGN_OUT_WORDS).test(words)) return refuse("sign-in", `Skipped “${label}” because signing out would end the session the exploration uses`);
    if (!ctx.allowDataChanges && changesData(words)) {
        // The button of a sign-in screen is often called "submit" in the app's code; signing in is not creating anything, but signing up is.
        const signIn = snap.elements.some((e) => e.password) && !/(sign.?up|signup|regist|creat|inscri|anmeld)/.test(words);
        if (!signIn && !/(search|find|suche|buscar|chercher)/.test(words)) return refuse("data-change", `Skipped “${label}” because it would change data, and tests that change data are switched off`);
    }
    const danger = screenDanger(snap);
    if (danger && !WAY_OUT.test(plain(`${el.text || el.desc} ${wordify(el.id)}`).trim())) {
        return refuse(danger === "payment" ? "payment" : "destructive", `Skipped “${label}” because this screen ${danger === "payment" ? "looks like a payment" : "looks destructive"}`);
    }
    return { ok: true };
}

// ── loops and stalls ────────────────────────────────────────────────────────

/** Refuses the Nth identical action in a row on the same screen. */
export class LoopGuard {
    private last = "";
    private count = 0;
    constructor(private readonly max: number) {}

    /** Would doing `sig` now repeat it too often? */
    wouldLoop(sig: string): boolean {
        return sig === this.last && this.count >= this.max;
    }
    record(sig: string): void {
        if (sig === this.last) this.count++;
        else {
            this.last = sig;
            this.count = 1;
        }
    }
}

/** Counts actions in a row after which nothing on the screen changed. */
export class StallGuard {
    private same = 0;
    constructor(private readonly max: number) {}
    /** `changed` is whether anything on the screen differs after the action. True when the exploration should end. */
    observe(changed: boolean): boolean {
        this.same = changed ? 0 : this.same + 1;
        return this.same >= this.max;
    }
    reset(): void {
        this.same = 0;
    }
}

export const permissionWords = { deny: DENY_BUTTON, allow: ALLOW_BUTTON };
