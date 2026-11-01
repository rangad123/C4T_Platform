/**
 * Which of an agent's actions need a person first. The rule is applied by code to what the page really shows, before the action happens: the
 * model can also ask for approval, but it cannot wave an action through, so a page that talks the model into something still reaches this check.
 *
 * Four things pause: deleting or ending something, paying, sending something to other people, and submitting a real form. A sign-in form is not a
 * real submission (the run may have a test account for it), and neither is a form that only reads (method GET, or a search form).
 *
 * It fails closed: an element that cannot be read pauses, a click on any button of a form that changes something pauses (a script may send it
 * whatever the button's type), and the "Yes" of a confirmation dialog pauses. Words are matched with camelCase split ("deleteAccount"), in
 * addresses too. Typing, choosing and ticking go through the words check as well, though they never count as sending a form.
 *
 * An element with no words about what it does, outside a form (a bare "Go" link that deletes), is still not recognised. The tools are limited to
 * the application's own site for that reason too, and the person chooses where a run starts.
 */

export type HighImpactKind = "delete" | "pay" | "send" | "submit";

export interface HighImpact {
    kind: HighImpactKind;
    why: string;
}

/** What the page says about the element an action is about. Read from the page, so its text is untrusted and only ever matched or shown as text. */
export interface ElementFacts {
    tag: string;
    type?: string;
    text?: string;
    ariaLabel?: string;
    title?: string;
    value?: string;
    href?: string;
    inForm?: boolean;
    formMethod?: string;
    formHasPassword?: boolean;
    formIsSearch?: boolean;
    /** The text of the element's label (inputs, checkboxes). */
    label?: string;
    /** Inside a dialog (`<dialog>`, role=dialog or alertdialog), and that dialog's text. */
    inDialog?: boolean;
    dialogText?: string;
}

export interface ActionFacts {
    action: "click" | "press" | "navigate" | "fill" | "select" | "check";
    key?: string;
    /** The option a select chooses. */
    value?: string;
    /** The address a navigate opens. */
    url?: string;
    /** The words of the locator the model used, in case the element itself could not be read. */
    locatorWords?: string;
    element?: ElementFacts;
    /** The model said this action is high impact. It can add a pause, never remove one. */
    modelSaysHighImpact?: boolean;
}

const WHY: Record<HighImpactKind, string> = {
    delete: "This looks like it deletes or ends something.",
    pay: "This looks like it pays for something or moves money.",
    send: "This looks like it sends something to other people.",
    submit: "This looks like it submits a real form.",
};

const UNREADABLE = "The element could not be read, so what it does cannot be told.";
const WHY_DIALOG = "This answers a confirmation dialog.";

const OWNER = "(?:an? |my |your |the |this )?";
const RULES: ReadonlyArray<{ kind: HighImpactKind; words: RegExp }> = [
    // A few common words of other languages where they are cheap to add (Spanish, Portuguese, French, German, Italian).
    { kind: "delete", words: new RegExp(`\\b(?:delete|remove|destroy|erase|purge|wipe|deactivate|revoke|unsubscribe|close ${OWNER}account|cancel ${OWNER}(?:account|subscription|membership|order|plan|booking)|eliminar|borrar|excluir|supprimer|effacer|l[öo]schen|entfernen|elimina|cancella)\\b`, "i") },
    { kind: "pay", words: new RegExp(`\\b(?:pay|payment|purchase|buy|checkout|check out|place ${OWNER}order|(?:confirm|complete) ${OWNER}(?:order|payment|purchase)|subscribe|upgrade|donate|transfer|withdraw|refund|pagar|comprar|payer|acheter|bezahlen|kaufen|paga|acquista)\\b`, "i") },
    { kind: "send", words: /\b(?:send|invite|publish|share|post (?:a |your |this )?(?:comment|message|reply|review|update)|enviar|envoyer|senden|invia)\b/i },
    { kind: "submit", words: new RegExp(`\\b(?:submit|sign ?up|register|create ${OWNER}(?:new )?account|apply|book|reserve|confirm)\\b`, "i") },
];

/** "deleteAccount" and "DeleteUser" read as "delete Account", "Delete User". */
const splitWords = (text: string) => text.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");

const byWords = (raw: string, kinds?: ReadonlySet<HighImpactKind>): HighImpact | undefined => {
    const text = splitWords(raw);
    for (const r of RULES) if ((!kinds || kinds.has(r.kind)) && r.words.test(text)) return { kind: r.kind, why: WHY[r.kind] };
    return undefined;
};

/** An address says what it does in its path and query only; a page called "Pay" is about money, a page called "Share" is usually only a page. */
const ADDRESS_KINDS: ReadonlySet<HighImpactKind> = new Set(["delete", "pay"]);

function byAddress(url: string | undefined): HighImpact | undefined {
    if (!url) return undefined;
    let words = url;
    try {
        const u = new URL(url, "http://site.invalid");
        words = `${u.pathname} ${u.search}`;
    } catch {
        // An address the parser cannot read is judged as it stands.
    }
    return byWords(words.replace(/[/?&=_.+-]+/g, " "), ADDRESS_KINDS);
}

/** A button of any type: a script may send the form from a type="button" as well. */
function isButton(e: ElementFacts): boolean {
    const tag = e.tag.toLowerCase();
    const type = (e.type ?? "").toLowerCase();
    if (tag === "button") return true;
    return tag === "input" && (type === "submit" || type === "image" || type === "button");
}

/** Does this action (a click, or Enter) act on a form that changes something? */
function submitsRealForm(a: ActionFacts): boolean {
    const e = a.element;
    if (!e?.inForm) return false;
    const fromKeyboard = a.action === "press" && a.key === "Enter" && e.tag.toLowerCase() === "input";
    if (!fromKeyboard && !(isButton(e) && (a.action === "click" || (a.action === "press" && a.key === "Enter")))) return false;
    if (e.formIsSearch || (e.formMethod ?? "").toLowerCase() === "get") return false;
    return !e.formHasPassword;
}

/** Why this action needs a person, or undefined when it may go ahead. */
export function highImpactOf(a: ActionFacts): HighImpact | undefined {
    if (a.action === "navigate") {
        const hit = byAddress(a.url);
        return hit ?? (a.modelSaysHighImpact ? { kind: "submit", why: "The agent asked for this to be approved." } : undefined);
    }
    // Moving around with Tab or Escape does nothing by itself; Enter acts on what has the focus.
    if (a.action === "press" && a.key !== "Enter") return a.modelSaysHighImpact ? { kind: "submit", why: "The agent asked for this to be approved." } : undefined;
    const e = a.element;
    // Typing reads the field's own words, not what is typed (typing "delete" into a search box deletes nothing); a choice reads the option too.
    const words = [e?.text, e?.ariaLabel, e?.title, e?.value, e?.label, a.locatorWords, a.action === "select" ? a.value : undefined].filter(Boolean).join(" ");
    const hit = byWords(words) ?? byAddress(e?.href);
    if (hit) return hit;
    if (a.action === "fill" || a.action === "select" || a.action === "check") return a.modelSaysHighImpact ? { kind: "submit", why: "The agent asked for this to be approved." } : undefined;
    // Fail closed: what cannot be read cannot be judged, so a person judges it.
    if (!e) return { kind: "submit", why: UNREADABLE };
    // A confirmation dialog: "Yes" or "OK" does what the dialog asks.
    if (e.inDialog && /\b(?:yes|ok|okay|confirm|continue|proceed|agree|accept|s[ií]|oui|ja)\b/i.test(words)) return byWords(e.dialogText ?? "") ?? { kind: "submit", why: WHY_DIALOG };
    if (submitsRealForm(a)) return { kind: "submit", why: WHY.submit };
    return a.modelSaysHighImpact ? { kind: "submit", why: "The agent asked for this to be approved." } : undefined;
}
