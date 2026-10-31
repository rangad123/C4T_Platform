/**
 * Fixture "Notes" app for the reusable-steps tests. One page:
 *   a Nickname field and a sign-in button (its name changes between runs: "Sign in", or "Log in" in the renamed mode),
 *   after signing in a status line "Signed in as <nickname>", an "Add note" button and a counter "Notes: n".
 * Also a JSON endpoint, so API tests that use a block have something real to call.
 */
import http from "node:http";

export type NotesMode = "original" | "renamed";

const page = (mode: NotesMode) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Notes</title></head>
<body><main><h1>Notes</h1>
<div><label for="nick">Nickname</label> <input id="nick" type="text"></div>
<button id="in">${mode === "renamed" ? "Log in" : "Sign in"}</button>
<p id="who" role="status"></p>
<button id="add" hidden>Add note</button>
<p id="count">Notes: 0</p>
<ul id="notes"></ul>
</main>
<script>
  let n = 0;
  document.getElementById("in").onclick = () => {
    document.getElementById("who").textContent = "Signed in as " + document.getElementById("nick").value;
    document.getElementById("add").hidden = false;
  };
  document.getElementById("add").onclick = () => {
    n++;
    const li = document.createElement("li"); li.textContent = "Note " + n; document.getElementById("notes").appendChild(li);
    document.getElementById("count").textContent = "Notes: " + n;
  };
</script></body></html>`;

export function startBlocksApp(port: number): Promise<{ server: http.Server; setMode(m: NotesMode): void }> {
    let mode: NotesMode = "original";
    const server = http.createServer((req, res) => {
        if (req.url?.startsWith("/api/notes")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ notes: [{ id: 1, text: "First" }] }));
            return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page(mode));
    });
    return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, setMode: (m) => void (mode = m) })));
}
