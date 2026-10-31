/**
 * The explorer loop: the AI model looks at one screen of the app at a time and chooses one action; the code checks it (safety.ts), types only
 * harmless data, performs it on the phone and records what happened as a model of the app (screens, how they connect, forms, sign-in).
 *
 * Bounded on every side (ExploreLimits): actions, minutes, screens, model calls, identical actions in a row, actions without any change.
 * The model never sees coordinates or a shell; it names elements by number, and an action on an element that is no longer there is refused.
 */
import { z } from "zod";
import { throwIfAborted, type EngineContext } from "../../context.js";
import { isBudgetExceeded } from "../../llm/usage.js";
import { escalateRoute, noteRouteActions, withRoute } from "../../llm/routing.js";
import { LlmNotConfiguredError } from "../../llm/provider.js";
import type { Shot } from "../../frames/shoot.js";
import type { DeviceAction, DeviceSession, ScreenElement, ScreenSnapshot } from "../device/types.js";
import { changedSince, describeScreen, type DescribeInput } from "./describe.js";
import { snapshotSavingsEvent, type SnapshotTotals } from "../../snapshots/compact.js";
import { compactSnapshotsOn } from "../../snapshots/setting.js";
import { ALL_FAKE_VALUES, fakeValueFor, fieldKindOf } from "./fake-data.js";
import { ANSWER_RETRY, EXPLORE_SYSTEM } from "./prompts.js";
import { dialogButtons, judgeAction, labelOf, LoopGuard, StallGuard } from "./safety.js";
import { fullKeyOf, isSignIn, nameScreens, newScreen, screenKeyOf, storeElements } from "./screens.js";
import { cleanAppText, looksLikeOrders } from "./text.js";
import { DEFAULT_LIMITS, PASSWORD_PLACEHOLDER, USERNAME_PLACEHOLDER, type Edge, type ExploreLimits, type MobileAppModel, type MobileScreen, type RecordedAction, type SkipNote, type Submit } from "./types.js";
import { permissionAnswerOf, rememberAnswer, type PermissionAnswer } from "../state/permission-step.js";
import type { ExploreQualityHooks } from "../quality/explore.js";
import { exploreMap, type MapExploreOptions } from "./map-explorer.js";

export { PASSWORD_PLACEHOLDER, USERNAME_PLACEHOLDER };

/** The model's answer for one turn. */
export const TurnReply = z.object({
    action: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("tap"), index: z.number().int().min(0).max(5000) }),
        z.object({ kind: z.literal("type"), index: z.number().int().min(0).max(5000), text: z.string().max(300) }),
        z.object({ kind: z.literal("scroll"), direction: z.enum(["up", "down", "left", "right"]) }),
        z.object({ kind: z.literal("back") }),
        z.object({ kind: z.literal("hideKeyboard") }),
        z.object({ kind: z.literal("wait"), ms: z.number().int().min(0).max(3000) }),
        z.object({ kind: z.literal("finish") }),
    ]),
    reason: z.string().max(400).optional(),
});
export type TurnReply = z.infer<typeof TurnReply>;

export interface ExploreOptions {
    ctx: EngineContext;
    session: DeviceSession;
    appPackage: string;
    /** Sign-in details were given: sign-in screens are filled with the placeholders. */
    credentialsGiven: boolean;
    /** "Include tests that change data" is on. */
    allowDataChanges: boolean;
    /** Values that must never appear in anything stored or shown (the project's sign-in details). */
    secrets?: readonly string[];
    limits?: Partial<ExploreLimits>;
    now?: () => number;
    /** Added by PQ: phone quality checks (crashes and freezes, start-up time, accessibility of each new screen), see mobile/quality/explore.ts. */
    quality?: ExploreQualityHooks;
    /**
     * Added in R24: "map" is the model-free map explorer (map-explorer.ts: the screen graph, the AI only where it pays, stops when the app looks
     * fully explored); "ai" (the default here, for callers that script the AI's turns) is this loop, where the AI chooses every action.
     * The pipeline chooses "map" unless the server is set to PHONE_EXPLORER=ai.
     */
    strategy?: "map" | "ai";
}

/** Counts every model call of an exploration (the exploration and the planning share one cap). */
export class ModelBudget {
    used = 0;
    constructor(readonly cap: number) {}
    get left(): number {
        return Math.max(0, this.cap - this.used);
    }
}

/** One turn's question to the model with one retry on an unusable answer. Undefined: no usable answer (the turn is skipped). */
export async function askTurn(ctx: EngineContext, prompt: string, budget: ModelBudget): Promise<TurnReply | undefined> {
    let problem = "";
    for (let attempt = 0; attempt < 2; attempt++) {
        if (budget.left <= 0) return undefined;
        budget.used++;
        try {
            const raw = await ctx.llm.object({ system: EXPLORE_SYSTEM, prompt: attempt === 0 ? prompt : `${prompt}\n\n${ANSWER_RETRY(problem)}`, schema: TurnReply, maxOutputTokens: 400, purpose: "analysis" });
            const parsed = TurnReply.safeParse(raw);
            if (parsed.success) return parsed.data;
            // An unusable answer: the turn is asked again, on the main model when a fast model gave it (llm/routing.ts).
            escalateRoute("gave no usable answer");
            problem = parsed.error.issues[0] ? `${parsed.error.issues[0].path.join(".") || "answer"}: ${parsed.error.issues[0].message}` : "the answer did not match the format";
        } catch (e) {
            // No model, or the AI limit was reached: not an unusable answer, the exploration cannot go on.
            if (e instanceof LlmNotConfiguredError || isBudgetExceeded(e)) throw e;
            problem = e instanceof Error ? e.message : String(e);
        }
    }
    return undefined;
}

type Prepared = { ok: true; action: DeviceAction; element?: ScreenElement } | { ok: false; note: SkipNote };

const skip = (why: SkipNote["why"], message: string): { ok: false; note: SkipNote } => ({ ok: false, note: { why, message } });

/**
 * Turns the model's choice into the action to perform. What is typed is decided here: sign-in fields take the placeholders (the session fills the
 * real value on the machine that owns the phone), every other field takes harmless data from the table, whatever the model proposed.
 */
export function prepareAction(reply: TurnReply["action"], snap: ScreenSnapshot, o: { credentialsGiven: boolean; searches: number }): Prepared {
    switch (reply.kind) {
        case "finish":
            return skip("invalid", "The AI chose to finish");
        case "tap": {
            const el = snap.elements.find((e) => e.index === reply.index);
            return el ? { ok: true, action: { kind: "tap", index: el.index }, element: el } : skip("invalid", "The AI chose an element that is not on the screen");
        }
        case "scroll":
            return { ok: true, action: { kind: "scroll", direction: reply.direction } };
        case "back":
        case "hideKeyboard":
            return { ok: true, action: { kind: reply.kind } };
        case "wait":
            return { ok: true, action: { kind: "wait", ms: Math.min(3000, Math.max(0, reply.ms)) } };
        case "type": {
            const el = snap.elements.find((e) => e.index === reply.index);
            if (!el) return skip("invalid", "The AI chose an element that is not on the screen");
            if (!el.editable) return skip("invalid", `Skipped typing into “${labelOf(el)}” because it is not a text field`);
            const base = { kind: "type" as const, index: el.index, clear: true };
            if (el.password) {
                if (!o.credentialsGiven) return skip("sign-in", "Skipped the password field because no sign-in details were given");
                return { ok: true, action: { ...base, text: PASSWORD_PLACEHOLDER }, element: el };
            }
            if (isSignIn(snap) && usernameFieldOf(snap)?.index === el.index) {
                if (!o.credentialsGiven) return skip("sign-in", "Skipped the user name field because no sign-in details were given");
                return { ok: true, action: { ...base, text: USERNAME_PLACEHOLDER }, element: el };
            }
            const proposed = reply.text.trim();
            return { ok: true, action: { ...base, text: ALL_FAKE_VALUES.has(proposed) ? proposed : fakeValueFor(el, o.searches) }, element: el };
        }
    }
}

/** The user name field of a sign-in screen: the last text field in front of the first password field. */
export function usernameFieldOf(snap: ScreenSnapshot): ScreenElement | undefined {
    const pw = snap.elements.findIndex((e) => e.password);
    if (pw < 0) return undefined;
    for (let i = pw - 1; i >= 0; i--) if (snap.elements[i]!.editable && !snap.elements[i]!.password) return snap.elements[i];
    return undefined;
}

// ── the loop ────────────────────────────────────────────────────────────────

interface Pos {
    snap: ScreenSnapshot;
    screen: MobileScreen;
}

/**
 * The exploration in its own route scope (llm/routing.ts): with a fast model set, the turns go to it, and the rest of the exploration
 * moves to the main model when it gives unusable answers, repeats itself or its actions keep failing. Without a fast model nothing changes.
 */
export function explore(o: ExploreOptions | MapExploreOptions, budget: ModelBudget = new ModelBudget(DEFAULT_LIMITS.maxModelCalls)): Promise<MobileAppModel> {
    if (o.strategy === "map") return withRoute({ task: "phone-explore", what: "The phone exploration" }, () => exploreMap(o, budget));
    return withRoute({ task: "phone-explore", what: "The phone exploration" }, () => exploreApp(o, budget));
}

async function exploreApp(o: ExploreOptions, budget: ModelBudget): Promise<MobileAppModel> {
    const { ctx, session } = o;
    const L: ExploreLimits = { ...DEFAULT_LIMITS, ...o.limits };
    const now = o.now ?? Date.now;
    const secrets = o.secrets ?? [];
    const started = now();
    const emit = (kind: string, message: string, level: "info" | "warn" = "info", data?: Record<string, unknown>) => ctx.emit({ stage: "discovery", kind, level, message, ...(data ? { data } : {}) });

    const byKey = new Map<string, MobileScreen>();
    const screens: MobileScreen[] = [];
    const edges: Edge[] = [];
    const edgeKeys = new Set<string>();
    const submits: Submit[] = [];
    const skipped: SkipNote[] = [];
    /** Permission questions answered on the way into the app (not after an action): the written tests answer them the same way (state/permission-step.ts). */
    const permissions: PermissionAnswer[] = [];
    const path: string[] = [];
    let actions = 0;
    let stopped = "";
    let searches = 0;
    let signInSeen = false;
    let budgetStop = "";
    let preludeLost = false;
    // Smaller screen descriptions (setting LLM_COMPACT_SNAPSHOTS, snapshots/phone.ts): counted against the description of before.
    const compact = compactSnapshotsOn(ctx.config);
    const screenTotals: SnapshotTotals = { snapshots: 0, compact: 0, diffs: 0, wholePage: 0, baselineChars: 0, sentChars: 0, baselineInputChars: 0, sentInputChars: 0 };
    const countScreen = (before: string, sent: string) => {
        screenTotals.snapshots++;
        screenTotals.compact++;
        screenTotals.baselineChars += before.length;
        screenTotals.sentChars += sent.length;
        screenTotals.baselineInputChars += before.length;
        screenTotals.sentInputChars += sent.length;
    };

    const register = (snap: ScreenSnapshot): { screen: MobileScreen; isNew: boolean } => {
        const key = screenKeyOf(snap);
        const known = byKey.get(key);
        if (known) {
            known.visits++;
            return { screen: known, isNew: false };
        }
        const screen = newScreen(`S${screens.length + 1}`, snap, screens.length === 0, secrets);
        byKey.set(key, screen);
        screens.push(screen);
        emit("mobile_screen_found", `Found screen ${screen.id} “${screen.title}”`, "info", { screen: screen.id });
        o.quality?.onNewScreen?.(snap, { id: screen.id, title: screen.title });
        // Text on a screen that tries to give the AI orders is removed before the AI reads it; the person is told it was there.
        if (snap.elements.some((e) => looksLikeOrders(e.text) || looksLikeOrders(e.desc))) emit("mobile_hostile_text", `“${screen.title}” has text that looks like instructions to the AI. It was removed from what the AI reads, and only the platform's own rules decide what is tapped.`, "warn", { screen: screen.id });
        return { screen, isNew: true };
    };
    const note = (n: SkipNote) => {
        if (skipped.length < 60) skipped.push(n);
        emit("mobile_action_skipped", n.message, "info", { why: n.why });
    };

    /** The live picture: only made when somebody is watching. The snapshot with its picture replaces the plain one, so the numbers the model uses stay the phone's. */
    const shotOf = (snap: ScreenSnapshot, title: string): Shot | null => {
        if (!snap.screenshot) return null;
        const jpeg = Buffer.from(snap.screenshot, "base64");
        return { jpeg, url: `android-app://${o.appPackage}`, title };
    };
    const look = async (fallback?: ScreenSnapshot): Promise<ScreenSnapshot> => (ctx.frames?.wants?.() ? session.snapshot({ screenshot: true }) : (fallback ?? session.snapshot()));
    const show = async (snap: ScreenSnapshot, title: string, line: string, phase: "exploring" | "signing-in" = "exploring") => {
        if (!snap.screenshot) return;
        await ctx.frames?.captureShot?.(async () => shotOf(snap, title), { note: cleanAppText(line, 80), phase, pagesSeen: screens.length });
    };

    /**
     * A permission question: "Don't allow" unless the dialog has no such button, or the app asked the same question again straight after a denial
     * (then it cannot go on without it). Never anything else.
     */
    const dialogsDenied = new Set<string>();
    const answerDialog = (s: ScreenSnapshot): { el: ScreenElement; key: string } | undefined => {
        const dlg = dialogButtons(s);
        if (!dlg.deny && !dlg.allow) return undefined;
        const key = screenKeyOf(s);
        const insist = dlg.deny !== undefined && dlg.allow !== undefined && dialogsDenied.has(key);
        const el = dlg.deny && !insist ? dlg.deny : (dlg.allow ?? dlg.deny);
        return el ? { el, key } : undefined;
    };

    // ── the first screen ────────────────────────────────────────────────────
    await o.quality?.atStart?.();
    let snap = await session.snapshot();
    for (let i = 0; i < 4 && (snap.outsideApp || snap.package !== o.appPackage); i++) {
        // A permission question on the way in is answered like any other; anything else: open the app.
        const pick = snap.outsideApp ? answerDialog(snap) : undefined;
        const r = await session.act(pick ? { kind: "tap", index: pick.el.index } : { kind: "launch" });
        if (!r.ok && !pick) throw new Error(r.error ?? "The app could not be started on the phone");
        // An answer that did not reach the phone is not an answer: the same choice is made again, never the other button.
        if (pick && r.ok) {
            dialogsDenied.add(pick.key);
            rememberAnswer(permissions, permissionAnswerOf(snap, pick.el));
            emit("mobile_note", `Answered a permission question with “${labelOf(pick.el)}”`);
        }
        snap = r.snapshot ?? (await session.snapshot());
    }
    if (snap.outsideApp || snap.package !== o.appPackage) throw new Error("The app did not open on the phone. Check the app package in Settings, Mobile app.");
    snap = await look(snap);
    let cur: Pos = { snap, screen: register(snap).screen };
    path.push(`opened ${cur.screen.title}`);
    emit("mobile_started", `Opened ${o.appPackage} on ${session.deviceName}`);
    await show(snap, cur.screen.title, `Opened ${cur.screen.title}`);
    const startId = cur.screen.id;

    let pending: RecordedAction[] = [];
    /** An action whose result was a system dialog: its screen is known only when the dialog has been dealt with. */
    let inFlight: { rec: RecordedAction; from: Pos; prelude: RecordedAction[] } | undefined;
    const loop = new LoopGuard(L.maxIdentical);
    const stall = new StallGuard(L.stallActions);
    let lastFull = fullKeyOf(snap);
    let unusable = 0;
    let outsideTries = 0;
    let refusedHere: string[] = [];
    let changed = "This is the first screen.";

    const addEdge = (from: string, to: string, prelude: RecordedAction[], action: RecordedAction, incomplete: boolean) => {
        const sig = JSON.stringify([from, to, prelude, action]);
        if (edgeKeys.has(sig) || edges.length >= L.maxEdges) return;
        edgeKeys.add(sig);
        edges.push({ id: `T${edges.length + 1}`, from, to, prelude, action, ...(incomplete ? { incomplete: true as const } : {}) });
    };
    /** What the action did, once the phone shows the app again. */
    const commit = (rec: RecordedAction, from: Pos, prelude: RecordedAction[], after: ScreenSnapshot): Pos => {
        // The same screen with a message added (an error under a field, a confirmation) is the same screen: what was shown is what a test checks.
        const effect = rec.kind !== "back" ? shownBy(from.snap, after) : [];
        const reg = effect.length ? { screen: from.screen, isNew: false } : register(after);
        const sameScreen = reg.screen.id === from.screen.id;
        const to: Pos = { snap: after, screen: reg.screen };
        if (sameScreen) {
            const isSubmit = rec.kind === "tap" && from.screen.hasForm && effect.length > 0;
            if (isSubmit) {
                const typed = prelude.some((p) => p.kind === "type");
                const stored = storeElements(after, secrets);
                const shown = effect.slice(0, 3).map((i) => ({ text: cleanAppText(after.elements[i]!.text || after.elements[i]!.desc, 60), ...(stored[i]?.loc ? { loc: stored[i]!.loc } : {}) }));
                if (!submits.some((s) => s.screen === from.screen.id && s.filled === typed)) submits.push({ screen: from.screen.id, filled: typed, prelude: [...prelude], tap: rec, shown });
            }
            // Sending a form that only answered with a message changes nothing a later step depends on: it is a result of its own, not part of the way in.
            if (rec.kind !== "back" && !isSubmit) pending = [...prelude, rec].slice(-L.maxPrelude);
            else pending = prelude;
            if (rec.kind !== "back" && !isSubmit && prelude.length + 1 > L.maxPrelude) preludeLost = true;
        } else {
            addEdge(from.screen.id, reg.screen.id, prelude, rec, preludeLost);
            pending = [];
            preludeLost = false;
        }
        return to;
    };

    const finish = (why: string) => {
        stopped = why;
    };

    // ── turn by turn ────────────────────────────────────────────────────────
    while (!stopped) {
        throwIfAborted(ctx.signal);
        if (actions >= L.maxActions) finish(`The limit of ${L.maxActions} actions was reached`);
        else if (now() - started >= L.maxMs) finish(`The time limit of ${Math.round(L.maxMs / 60_000)} minutes was reached`);
        else if (screens.length >= L.maxScreens) finish(`The limit of ${L.maxScreens} screens was reached`);
        else if (budget.left <= 1) finish("The limit of AI calls for one exploration was reached");
        if (stopped) break;

        // The phone shows something that is not the app (a permission dialog, another app).
        if (snap.outsideApp) {
            outsideTries++;
            if (outsideTries > 6) {
                finish("The phone stayed outside the app");
                break;
            }
            const pick = answerDialog(snap);
            let act: DeviceAction;
            let said: string;
            if (pick) {
                act = { kind: "tap", index: pick.el.index };
                said = `Answered a permission question with “${labelOf(pick.el)}”`;
            } else if (outsideTries <= 2) {
                act = { kind: "back" };
                said = "Went back because the phone left the app";
            } else {
                act = { kind: "launch" };
                said = "Opened the app again because the phone left it";
            }
            const verdict = judgeAction(act, snap, { allowDataChanges: o.allowDataChanges });
            if (!verdict.ok) {
                note({ why: verdict.why, message: verdict.message });
                act = { kind: "back" };
            }
            actions++;
            const r = await session.act(act);
            if (pick && r.ok) dialogsDenied.add(pick.key);
            if (pick && r.ok && !inFlight) rememberAnswer(permissions, permissionAnswerOf(snap, pick.el));
            emit("mobile_note", said);
            snap = await look(r.snapshot);
            await show(snap, snap.outsideApp ? "Outside the app" : cur.screen.title, said);
            if (!snap.outsideApp) {
                outsideTries = 0;
                if (inFlight) {
                    cur = commit(inFlight.rec, inFlight.from, inFlight.prelude, snap);
                    inFlight = undefined;
                } else {
                    const reg = register(snap);
                    if (reg.screen.id !== cur.screen.id) pending = [];
                    cur = { snap, screen: reg.screen };
                }
                lastFull = fullKeyOf(snap);
            }
            continue;
        }
        outsideTries = 0;

        if (cur.screen.kind === "signin" && !o.credentialsGiven && !signInSeen) {
            signInSeen = true;
            emit("mobile_sign_in_needed", `“${cur.screen.title}” asks for sign-in details and none were given, so the AI continues with what it can reach`, "warn");
        }

        // Ask the model; refused or unusable choices are asked again (a refused choice is told to the model so it picks something else).
        let chosen: Prepared & { ok: true } | undefined;
        let wantsFinish = false;
        for (let tries = 0; tries < 3 && !chosen && !wantsFinish; tries++) {
            if (budget.left <= 1) break;
            const described: DescribeInput = {
                appPackage: o.appPackage,
                snapshot: snap,
                screenId: cur.screen.id,
                isNew: cur.screen.visits === 1,
                visited: screens.map((s) => ({ id: s.id, title: s.title })),
                path,
                changed,
                refused: refusedHere,
                budget: { actions: L.maxActions - actions, minutes: Math.max(0, Math.round((L.maxMs - (now() - started)) / 60_000)), screens: L.maxScreens - screens.length },
                allowDataChanges: o.allowDataChanges,
                credentialsGiven: o.credentialsGiven,
                secrets,
            };
            const prompt = describeScreen(compact ? { ...described, compact: true } : described);
            if (compact) countScreen(describeScreen(described), prompt);
            let reply: TurnReply | undefined;
            try {
                reply = await askTurn(ctx, prompt, budget);
            } catch (e) {
                // A reached AI limit ends the exploration with what it has learned so far; nothing is lost and nothing is called a failure.
                if (!isBudgetExceeded(e)) throw e;
                budgetStop = e.message;
                break;
            }
            if (!reply) break;
            if (reply.action.kind === "finish") {
                wantsFinish = true;
                break;
            }
            const prep = prepareAction(reply.action, snap, { credentialsGiven: o.credentialsGiven, searches });
            if (!prep.ok) {
                note(prep.note);
                refusedHere.push(prep.note.message.replace(/^Skipped /, ""));
                // An element that is not on the screen (or not a field) is the model's mistake; a skipped sign-in field is not.
                if (prep.note.why === "invalid") noteRouteActions([{ key: `invalid ${JSON.stringify(reply.action)}`, ok: false }]);
                continue;
            }
            const verdict = judgeAction(prep.action, snap, { allowDataChanges: o.allowDataChanges });
            if (!verdict.ok) {
                note({ why: verdict.why, message: verdict.message });
                refusedHere.push(verdict.message.replace(/^Skipped /, ""));
                continue;
            }
            const sig = `${screenKeyOf(snap)}|${prep.action.kind}|${"index" in prep.action ? prep.action.index : ""}|${prep.action.kind === "scroll" ? prep.action.direction : ""}`;
            if (loop.wouldLoop(sig)) {
                const what = prep.element ? `“${labelOf(prep.element)}”` : prep.action.kind;
                note({ why: "loop", message: `Skipped ${what} because it was just done ${L.maxIdentical} times in a row` });
                refusedHere.push(`${what} (done too often)`);
                escalateRoute(`kept choosing an action it had just done ${L.maxIdentical} times in a row`);
                continue;
            }
            chosen = { ...prep };
        }
        if (budgetStop) {
            finish(budgetStop);
            break;
        }
        if (wantsFinish) {
            finish("The AI decided it had seen enough");
            break;
        }
        // Only the model's own choices count for escalation, not the step away the code takes below.
        const byModel = chosen !== undefined;
        if (!chosen) {
            unusable++;
            if (unusable >= 3) {
                finish(budget.left <= 1 ? "The limit of AI calls for one exploration was reached" : "The AI kept choosing actions that could not be used");
                break;
            }
            // Nothing usable: step away from this screen rather than ask forever.
            chosen = { ok: true, action: cur.screen.id === startId ? { kind: "scroll", direction: "down" } : { kind: "back" } };
        } else unusable = 0;
        refusedHere = [];

        // ── do it ───────────────────────────────────────────────────────────
        const action = chosen.action;
        const el = chosen.element;
        if (action.kind === "type") searches += fieldKindOf(el!) === "search" ? 1 : 0;
        const sig = `${screenKeyOf(snap)}|${action.kind}|${"index" in action ? action.index : ""}|${action.kind === "scroll" ? action.direction : ""}`;
        const rec = recordOf(action, el, cur.screen.id, snap, secrets);
        actions++;
        path.push(describeDone(action, el, cur.screen.title));
        const prelude = pending;
        const res = await session.act(action);
        loop.record(sig);
        // The app crashed or froze (read from the phone's own log): recorded by the quality checks; the app is started again and the exploration goes on.
        if ((await o.quality?.afterAction?.({ before: snap, screen: { id: cur.screen.id, title: cur.screen.title }, path, prelude, ...(rec ? { action: rec } : {}) })) === "restart") {
            const again = await session.act({ kind: "restart" });
            snap = await look(again.snapshot);
            pending = [];
            inFlight = undefined;
            if (!snap.outsideApp) cur = { snap, screen: register(snap).screen };
            lastFull = fullKeyOf(snap);
            changed = "The app crashed or stopped responding, and was started again from its first screen.";
            path.push("Restarted the app after it crashed");
            await show(snap, snap.outsideApp ? "Outside the app" : cur.screen.title, "Restarted the app after it crashed");
            continue;
        }
        if (!res.ok) {
            note({ why: "invalid", message: `Could not do that: ${cleanAppText(res.error ?? "the phone did not accept it", 160)}` });
            if (byModel) noteRouteActions([{ key: sig, ok: false }]);
            snap = await look();
            if (!snap.outsideApp) cur = { snap, screen: register(snap).screen };
            if (stall.observe(false)) finish("Nothing on the screen changed for several actions in a row");
            continue;
        }
        const before = snap;
        const fromId = cur.screen.id;
        const next = await look(res.snapshot);
        const full = fullKeyOf(next);
        const stalled = stall.observe(full !== lastFull);
        if (byModel) noteRouteActions([{ key: sig, ok: true, progress: full !== lastFull }]);
        lastFull = full;
        snap = next;
        if (next.outsideApp) {
            inFlight = rec ? { rec, from: cur, prelude } : undefined;
            changed = "The last action opened something outside the app.";
            await show(next, "Outside the app", `${describeDone(action, el, cur.screen.title)}`);
            continue;
        }
        if (rec) cur = commit(rec, cur, prelude, next);
        else cur = { snap: next, screen: register(next).screen };
        changed = changedSince(before, next, cur.screen.id === fromId, secrets);
        const doneLine = action.kind === "back" ? "Went back" : cur.screen.visits === 1 && action.kind !== "type" ? `Opened ${cur.screen.title}` : describeDone(action, el, cur.screen.title);
        await show(next, cur.screen.title, doneLine, cur.screen.kind === "signin" || action.kind === "type" && (el?.password || false) ? "signing-in" : "exploring");
        if (stalled) finish("Nothing on the screen changed for several actions in a row");
    }

    // The loop never gives up the phone quietly: it says why it stopped.
    // What the smaller descriptions saved, only when they saved something (small screens are sent as before); the end line stays last.
    if (compact && screenTotals.sentChars < screenTotals.baselineChars) ctx.emit(snapshotSavingsEvent("Phone exploration", screenTotals, "phone"));
    emit("mobile_exploration_done", `Exploration ended: ${stopped || "done"}. ${screens.length} screens, ${actions} actions.`);
    // Screens that share a name are told apart in words (screens.ts nameScreens, R24 PLAN): never "Search (4)".
    nameScreens(screens, edges);
    const signedIn = edges.some((e) => [...e.prelude, e.action].some((a) => a.kind === "type" && a.text === PASSWORD_PLACEHOLDER) && byId(screens, e.to)?.kind !== "signin");
    return {
        appPackage: o.appPackage,
        start: startId,
        screens,
        edges,
        submits,
        signInNeeded: screens.some((s) => s.kind === "signin") && !signedIn,
        signedIn,
        skipped,
        stats: { actions, modelCalls: budget.used, durationMs: now() - started, stoppedBecause: stopped || "done", ...(budgetStop ? { aiLimit: budgetStop } : {}) },
        ...(permissions.length ? { permissions } : {}),
    };
}

const byId = (screens: readonly MobileScreen[], id: string) => screens.find((s) => s.id === id);

/**
 * Positions (in `after`) of the 1-3 texts that appeared on a screen that is otherwise the same: same app and activity, nearly everything still
 * there. An empty list means the screen really changed (or nothing new appeared).
 */
export function shownBy(before: ScreenSnapshot, after: ScreenSnapshot): number[] {
    if (before.package !== after.package || (before.activity ?? "") !== (after.activity ?? "")) return [];
    const key = (e: ScreenElement) => `${e.id}|${e.text}|${e.desc}`;
    const was = new Set(before.elements.map(key));
    const stays = new Set(after.elements.map((e) => `${e.id}|${e.cls}`));
    const kept = before.elements.filter((e) => stays.has(`${e.id}|${e.cls}`)).length;
    if (before.elements.length === 0 || kept / before.elements.length < 0.8) return [];
    const added = after.elements.map((e, i) => ({ e, i })).filter(({ e }) => !was.has(key(e)) && !e.password && !e.editable && (e.text || e.desc).trim().length >= 2);
    return added.length >= 1 && added.length <= 3 ? added.map(({ i }) => i) : [];
}

/** How a test repeats the action: by how the element is found, never by its place on the screen. Undefined: it cannot be repeated (an element with no name). */
export function recordOf(action: DeviceAction, el: ScreenElement | undefined, screenId: string, snap: ScreenSnapshot, secrets: readonly string[]): RecordedAction | undefined {
    switch (action.kind) {
        case "tap":
        case "type": {
            if (!el) return undefined;
            const stored = storeElements(snap, secrets)[snap.elements.indexOf(el)];
            const base = { screen: screenId, label: labelOf(el), ...(stored?.loc ? { loc: stored.loc } : {}) };
            return action.kind === "tap" ? { kind: "tap", ...base } : { kind: "type", ...base, text: action.text };
        }
        case "scroll":
            return { kind: "scroll", direction: action.direction };
        case "back":
            return { kind: "back" };
        case "hideKeyboard":
            return { kind: "hideKeyboard" };
        case "wait":
            return { kind: "wait", ms: action.ms };
        default:
            return undefined;
    }
}

/** One plain line for what was done: names of things the AI chose, never what was typed. */
export function describeDone(action: DeviceAction, el: ScreenElement | undefined, screenTitle: string): string {
    switch (action.kind) {
        case "tap":
            return `Tapped “${el ? labelOf(el) : "an item"}”`;
        case "type":
            return `Typed in the ${el ? `“${labelOf(el)}”` : "text"} field`;
        case "scroll":
            return `Scrolled ${action.direction} on ${screenTitle}`;
        case "back":
            return "Went back";
        case "hideKeyboard":
            return "Hid the keyboard";
        case "wait":
            return "Waited a moment";
        case "launch":
            return "Opened the app";
        case "restart":
            return "Restarted the app";
        case "longPress":
            return `Pressed and held “${el ? labelOf(el) : "an item"}”`;
    }
}

export { looksLikeOrders };
