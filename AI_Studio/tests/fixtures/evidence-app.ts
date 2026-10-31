/**
 * Fixture app for the failure-evidence tests. Pages, each with one way to go wrong (or none):
 *   /        a normal page: one request that works, one console.log
 *   /cart    "Add to cart" posts a body with a secret to /api/cart, which answers 500 (with a secret in a response header);
 *            the page logs a console error
 *   /boom    throws an uncaught exception after load
 *   /login   fills in a password and checks it with a request that puts the password in the query string, logs it, and
 *            logs a bearer token, a JWT, a long hex string and "password=..." next to it
 *   /many    makes 1000 requests, then one that answers 500
 * Nothing in here is a mock of the platform; it is the application under test.
 */
import http from "node:http";

/** Greppable values: none of them may appear in anything the platform stores. */
export const EVIDENCE_SENTINELS = {
    requestBody: "EVID-RequestBody-3f9a2c",
    responseBody: "EVID-ResponseBody-71be0d",
    responseHeader: "EVID-ResponseHeader-c4d815",
    cookie: "EVID-Cookie-8a60e2",
    queryToken: "EVID-QueryToken-5d27b9",
    querySession: "EVID-QuerySession-e03f71",
    bearer: "EVID-Bearer-b6c94a1f",
    jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJFVklELUp3dC0xMjM0NTY3ODkwIn0.EVIDJwtSignature9a1b2c",
    hex: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    inlineSecret: "EVID-Inline-hunter22x",
};

const html = (title: string, body: string, script = "") =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main><script>${script}</script></body></html>`;

export function startEvidenceApp(port: number): Promise<http.Server> {
    const S = EVIDENCE_SENTINELS;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        const send = (status: number, type: string, body: string, headers: Record<string, string> = {}) => {
            res.writeHead(status, { "content-type": type, ...headers });
            res.end(body);
        };
        switch (url.pathname) {
            case "/":
                return send(200, "text/html", html("Evidence home", "<p>Everything works here.</p>", `console.log("home ready"); fetch("/api/hello?page=home").then((r) => r.json());`), { "set-cookie": `sid=${S.cookie}; Path=/; HttpOnly` });
            case "/cart":
                return send(
                    200,
                    "text/html",
                    html(
                        "Cart",
                        `<button id="add">Add to cart</button><p id="msg" role="status"></p>`,
                        `document.getElementById("add").onclick = async () => {
                           const r = await fetch("/api/cart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: "${S.requestBody}" }) });
                           if (!r.ok) { console.error("Could not add to cart: the server answered " + r.status); document.getElementById("msg").textContent = "Something went wrong"; }
                           else document.getElementById("msg").textContent = "Added";
                         };`,
                    ),
                );
            case "/boom":
                return send(200, "text/html", html("Boom page", "<p>This page breaks.</p>", `setTimeout(() => { throw new Error("Boom: the checkout widget crashed"); }, 30);`));
            case "/login":
                return send(
                    200,
                    "text/html",
                    html(
                        "Check password",
                        `<label for="pw">Password</label> <input id="pw" type="password"> <button id="go">Check</button><p id="msg" role="status"></p>`,
                        `document.getElementById("go").onclick = async () => {
                           const pw = document.getElementById("pw").value;
                           console.log("checked with " + pw);
                           console.log("Authorization: Bearer ${S.bearer}");
                           console.log("session jwt ${S.jwt} and digest ${S.hex}");
                           console.log("retrying with password=${S.inlineSecret} and mode=quick");
                           const r = await fetch("/api/check?mode=quick&token=${S.queryToken}&u=" + encodeURIComponent(pw) + "&page=login&session=${S.querySession}");
                           document.getElementById("msg").textContent = r.ok ? "Accepted" : "Rejected";
                         };`,
                    ),
                );
            case "/many":
                return send(
                    200,
                    "text/html",
                    html(
                        "Many requests",
                        `<p id="msg" role="status">Loading</p>`,
                        `(async () => {
                           for (let i = 0; i < 1000; i++) fetch("/api/n?i=" + i).catch(() => undefined);
                           await new Promise((r) => setTimeout(r, 800));
                           const r = await fetch("/api/fail");
                           document.getElementById("msg").textContent = r.ok ? "Done" : "Failed at the end";
                         })();`,
                    ),
                );
            case "/favicon.ico":
                return send(204, "image/x-icon", "");
            case "/api/hello":
                return send(200, "application/json", '{"hello":"world"}');
            case "/api/cart": {
                req.resume();
                return send(500, "application/json", `{"error":"${S.responseBody}"}`, { "x-debug-token": S.responseHeader, "set-cookie": `sid=${S.cookie}; Path=/; HttpOnly` });
            }
            case "/api/check":
                // The password comes back in a response header too: a header must never be stored.
                return send(401, "application/json", '{"ok":false}', { "x-echo": url.searchParams.get("u") ?? "" });
            case "/api/fail":
                return send(500, "application/json", '{"error":"nope"}');
            case "/api/n":
                return send(200, "application/json", "{}");
            default:
                return send(404, "text/plain", "not found");
        }
    });
    return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
