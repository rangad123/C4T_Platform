/**
 * A small application shaped like a real one whose signed-in landing page is called "Account", never "Dashboard" (for
 * tests/case-scripts-account.test.ts):
 *   /            a home page with a "Sign in" link
 *   /login       Email + Password + "Sign in" -> /account          account: tester@account.test / Account-Pass-7
 *   /account     heading "Account" and "Signed in as tester@account.test" (signed in only; else back to /login)
 * No page says "Dashboard" anywhere.
 */
import http from "node:http";

export const ACCOUNT_USER = { email: "tester@account.test", password: "Account-Pass-7" };

export interface AccountSite {
    close(): Promise<void>;
}

const page = (body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Workspace</title></head><body><main>${body}</main></body></html>`;

export function startAccountSite(port: number): Promise<AccountSite> {
    const server = http.createServer((req, res) => {
        const path = new URL(req.url ?? "/", "http://x").pathname;
        const html = (body: string, code = 200) => {
            res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
            res.end(page(body));
        };
        if (path === "/login" && req.method === "POST") {
            let body = "";
            req.on("data", (d) => (body += d));
            req.on("end", () => {
                const f = new URLSearchParams(body);
                if (f.get("email") === ACCOUNT_USER.email && f.get("password") === ACCOUNT_USER.password) {
                    res.writeHead(302, { location: "/account", "set-cookie": "session=ok; Path=/; HttpOnly" });
                    return void res.end();
                }
                html(`<h1>Sign in</h1><p role="alert">Wrong email or password</p>`, 401);
            });
            return;
        }
        if (path === "/") return html(`<h1>Workspace</h1><a href="/login">Sign in</a>`);
        if (path === "/login") {
            return html(`<h1>Sign in</h1><form method="post" action="/login"><label for="email">Email</label><input id="email" name="email" type="email"><label for="password">Password</label><input id="password" name="password" type="password"><button type="submit">Sign in</button></form>`);
        }
        if (path === "/account") {
            if (!(req.headers.cookie ?? "").includes("session=ok")) {
                res.writeHead(302, { location: "/login" });
                return void res.end();
            }
            return html(`<h1>Account</h1><p>Signed in as ${ACCOUNT_USER.email}</p>`);
        }
        html(`<h1>Not found</h1>`, 404);
    });
    return new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () =>
            resolve({
                close: () =>
                    new Promise<void>((r) => {
                        server.closeAllConnections?.();
                        server.close(() => r());
                    }),
            }),
        );
    });
}
