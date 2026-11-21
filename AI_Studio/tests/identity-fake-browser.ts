/**
 * A scripted browser for the access-check helper in the generated script (ACCESS_HELPER_SOURCE): every new context is its own signed-in
 * state, the sign-in form accepts any account whose TEST_<NAME>_USERNAME is set, visiting a page makes the app's own API call for the
 * signed-in account (with its own token, when the account has one), and API answers come from `answer`.
 */
import { createHmac } from "node:crypto";
import { ACCESS_HELPER_SOURCE } from "../src/engine/identity/access.js";

// A normal project's script: HTTPS errors are not ignored (IGNORE_HTTPS_ERRORS, as the generators declare it).
export const accessHelper = new Function("totpCode", "createHmac", "IGNORE_HTTPS_ERRORS", `${ACCESS_HELPER_SOURCE}\nreturn { accessAssert };`)(() => "000000", createHmac, false) as {
    accessAssert: (page: unknown, base: string, spec: string) => Promise<void>;
};

export interface FakeCall {
    who: string;
    url: string;
    headers: Record<string, string>;
}
export type FakeAnswer = { status: number; body: string } | null;

export function fakeBrowser(opts: {
    answer: (call: FakeCall) => FakeAnswer;
    ownCall?: (who: string) => { url: string; headers?: Record<string, string> } | undefined;
    noBrowser?: boolean;
}) {
    const calls: FakeCall[] = [];
    let contexts = 0;
    const options: Array<Record<string, unknown>> = [];
    const newContext = async (o: Record<string, unknown>) => {
        contexts++;
        options.push(o);
        const state = { typed: "", who: "anonymous" };
        let listener: ((r: unknown) => void) | undefined;
        const loc = (sel: string): Record<string, unknown> => {
            const self: Record<string, unknown> = {
                count: async () => (/one-time-code/.test(sel) ? 0 : /password/.test(sel) ? (state.who === "anonymous" ? 1 : 0) : 1),
                first: () => self,
                or: () => self,
                locator: (s: string) => loc(`${sel} ${s}`),
                getByRole: (role: string) => loc(`${sel} role=${role}`),
                isVisible: async () => false,
                innerText: async () => "",
                fill: async (v: string) => {
                    if (/type=email/.test(sel)) state.typed = v;
                },
                click: async () => void (state.who = state.typed.split("@")[0] || "anonymous"),
                press: async () => void (state.who = state.typed.split("@")[0] || "anonymous"),
            };
            return self;
        };
        const page = {
            goto: async () => {
                const own = state.who === "anonymous" ? undefined : opts.ownCall?.(state.who);
                if (own) listener?.({ url: () => own.url, headers: () => own.headers ?? {} });
                return null;
            },
            waitForLoadState: async () => undefined,
            waitForTimeout: async () => undefined,
            locator: (s: string) => loc(s),
            getByRole: () => loc("role"),
            url: () => "http://app.test/",
            on: (_: string, f: (r: unknown) => void) => void (listener = f),
            off: () => undefined,
            close: async () => undefined,
        };
        return {
            newPage: async () => page,
            close: async () => undefined,
            cookies: async () => [],
            addCookies: async () => undefined,
            request: {
                post: async () => ({ status: () => 200 }),
                get: async (url: string, o: { headers: Record<string, string> }) => {
                    const call = { who: state.who, url, headers: o.headers };
                    calls.push(call);
                    const a = opts.answer(call);
                    if (!a) throw new Error("unreachable");
                    return { status: () => a.status, text: async () => a.body };
                },
            },
        };
    };
    const page = {
        context: () => ({
            browser: () => (opts.noBrowser ? null : { newContext }),
        }),
    };
    return { page, calls, contexts: () => contexts, options };
}

/** Sign-in details for the named test accounts (the script reads TEST_<NAME>_USERNAME / _PASSWORD). */
export function setAccounts(names: string[]): void {
    for (const n of names) {
        process.env[`TEST_${n.toUpperCase()}_USERNAME`] = `${n}@example.test`;
        process.env[`TEST_${n.toUpperCase()}_PASSWORD`] = `pw-${n}`;
    }
}
