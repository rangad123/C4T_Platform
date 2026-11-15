/** A tiny HTTP client with one cookie jar, for the benchmark verifiers (plain fetch, no model, no browser). */
export interface BenchResponse {
    status: number;
    body: unknown;
    text: string;
    setCookie: string[];
}

export class BenchClient {
    private cookies = new Map<string, string>();
    constructor(readonly base: string) {}

    cookie(name: string): string | undefined {
        return this.cookies.get(name);
    }
    setCookie(name: string, value: string): void {
        this.cookies.set(name, value);
    }

    async call(method: string, path: string, body?: unknown): Promise<BenchResponse> {
        const headers: Record<string, string> = {};
        if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
        if (body !== undefined) headers["content-type"] = "application/json";
        const res = await fetch(new URL(path, this.base), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
        const setCookie = res.headers.getSetCookie();
        for (const c of setCookie) {
            const [pair, ...attrs] = c.split(";");
            const i = pair!.indexOf("=");
            const name = pair!.slice(0, i).trim();
            const value = pair!.slice(i + 1).trim();
            if (!value || attrs.some((a) => /max-age=0/i.test(a.trim()))) this.cookies.delete(name);
            else this.cookies.set(name, value);
        }
        const text = await res.text();
        let parsed: unknown = text;
        try {
            parsed = JSON.parse(text);
        } catch {
            /* an HTML page */
        }
        return { status: res.status, body: parsed, text, setCookie };
    }

    async signIn(email: string, password = "Password1!"): Promise<void> {
        const r = await this.call("POST", "/api/login", { email, password });
        if (r.status !== 200) throw new Error(`sign-in as ${email} failed: ${r.status}`);
    }
}

export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
