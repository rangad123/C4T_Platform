#!/usr/bin/env node
/**
 * The reference database probe (probe.mjs) over a SQLite file:
 *
 *   node examples/db-probe/server.mjs --sqlite <file> --token-file <file> --allow <tables.json> [--cert <pem> --key <pem>]
 *        [--host 127.0.0.1] [--port 8790] [--audit <file>] [--row-cap 100000] [--timeout-ms 5000] [--per-minute 120]
 *
 * HTTPS with --cert and --key. Without them it serves plain HTTP on a loopback address only (behind the customer's own TLS proxy, or
 * for a local trial); any other address without TLS is refused. The audit log is one JSON line per request (default: stderr).
 * Set-up guide: docs/features/database-checks.md.
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { parseArgs } from "node:util";
import { createProbe, DEFAULTS, parseAllow } from "./probe.mjs";
import { sqliteAdapter } from "./sqlite-adapter.mjs";

const { values: a } = parseArgs({
    options: {
        sqlite: { type: "string" },
        "token-file": { type: "string" },
        allow: { type: "string" },
        cert: { type: "string" },
        key: { type: "string" },
        host: { type: "string", default: "127.0.0.1" },
        port: { type: "string", default: "8790" },
        audit: { type: "string" },
        "row-cap": { type: "string", default: String(DEFAULTS.rowCap) },
        "timeout-ms": { type: "string", default: String(DEFAULTS.timeoutMs) },
        "per-minute": { type: "string", default: String(DEFAULTS.perMinute) },
    },
});
const fail = (m) => {
    console.error(`db-probe: ${m}`);
    process.exit(2);
};
if (!a.sqlite || !a["token-file"] || !a.allow) fail("--sqlite, --token-file and --allow are required");
const tls = a.cert && a.key ? { cert: fs.readFileSync(a.cert), key: fs.readFileSync(a.key) } : undefined;
if ((a.cert || a.key) && !tls) fail("--cert and --key go together");
if (!tls && !/^(127\.\d+\.\d+\.\d+|::1|localhost)$/.test(a.host)) fail("without --cert and --key the probe listens on a loopback address only");
const num = (k) => {
    const n = Number(a[k]);
    if (!Number.isSafeInteger(n) || n < 1) fail(`--${k} is a whole number above 0`);
    return n;
};
const allow = parseAllow(JSON.parse(fs.readFileSync(a.allow, "utf8")));
const auditFile = a.audit ? fs.openSync(a.audit, "a", 0o600) : undefined;
const handle = createProbe({
    adapter: sqliteAdapter(a.sqlite, allow),
    token: fs.readFileSync(a["token-file"], "utf8").trim(),
    allow,
    rowCap: num("row-cap"),
    timeoutMs: num("timeout-ms"),
    perMinute: num("per-minute"),
    audit: (e) => (auditFile === undefined ? process.stderr.write(`${JSON.stringify(e)}\n`) : fs.writeSync(auditFile, `${JSON.stringify(e)}\n`)),
});
const server = tls ? https.createServer(tls, handle) : http.createServer(handle);
server.listen(num("port"), a.host, () => console.log(`db-probe listening on ${tls ? "https" : "http"}://${a.host}:${server.address().port}`));
