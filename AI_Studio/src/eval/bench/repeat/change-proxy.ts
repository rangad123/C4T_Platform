/**
 * The regression trial's change, without touching the frozen benchmark apps: the platform explores the app through this loopback proxy,
 * and between the cold run and the repeat run one page's HTML is changed on its way back (a form field removed). Everything else passes
 * through unchanged (method, headers, body, status, cookies, redirects). The proxy counts how often the change matched, so a trial whose
 * page no longer has the text to change is reported as "not applied", never as a pass.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface PageChange {
    /** Short name for the report. */
    id: string;
    /** The page path the change applies to (exact, without the query). */
    path: string;
    /** What is taken out of the page's HTML (every match). */
    find: RegExp;
    replace: string;
    /** What a person would see, for the report. */
    what: string;
}

/** One change per benchmark app: a form field the crawl records is removed from a signed-in page. */
export const PAGE_CHANGES: Record<string, PageChange> = {
    "bench-shop": {
        id: "account-address-removed",
        path: "/account",
        find: /<label>Default delivery address <textarea[^]*?<\/textarea><\/label>/g,
        replace: "",
        what: "The account page no longer has the Default delivery address field.",
    },
    "bench-rbac": {
        id: "note-title-removed",
        path: "/notes/new",
        find: /<label>Title <input name="title"><\/label>/g,
        replace: "",
        what: "The new-note page no longer has the Title field.",
    },
};

export class ChangeProxy {
    private server?: http.Server;
    /** Pages changed while the change is on. */
    hits = 0;
    changed = false;
    url = "";

    constructor(
        private readonly upstream: string,
        private readonly change: PageChange | undefined,
    ) {}

    async start(port: number): Promise<void> {
        const up = new URL(this.upstream);
        this.server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const out = http.request(
                    { host: up.hostname, port: up.port, method: req.method, path: req.url, headers: { ...req.headers, host: `${up.hostname}:${up.port}` } },
                    (answer) => {
                        const body: Buffer[] = [];
                        answer.on("data", (c: Buffer) => body.push(c));
                        answer.on("end", () => {
                            let bytes = Buffer.concat(body);
                            const path = (req.url ?? "/").split("?")[0];
                            if (this.changed && this.change && req.method === "GET" && path === this.change.path && /text\/html/.test(String(answer.headers["content-type"] ?? ""))) {
                                const html = bytes.toString("utf8");
                                const next = html.replace(this.change.find, this.change.replace);
                                if (next !== html) this.hits++;
                                bytes = Buffer.from(next, "utf8");
                            }
                            const headers = { ...answer.headers, "content-length": String(bytes.length) };
                            delete headers["transfer-encoding"];
                            res.writeHead(answer.statusCode ?? 502, headers);
                            res.end(bytes);
                        });
                    },
                );
                out.on("error", () => {
                    if (!res.headersSent) res.writeHead(502);
                    res.end();
                });
                out.end(Buffer.concat(chunks));
            });
        });
        await new Promise<void>((resolve, reject) => {
            this.server!.once("error", reject);
            this.server!.listen(port, "127.0.0.1", () => resolve());
        });
        this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    }

    async stop(): Promise<void> {
        const s = this.server;
        this.server = undefined;
        if (s) await new Promise<void>((r) => s.close(() => r()));
    }
}
