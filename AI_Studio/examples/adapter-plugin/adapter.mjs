/**
 * Example adapter plug-in: "node-http-check".
 *
 * It turns the API steps of a test (request, assertResponse) into a small plain Node.js script, runs it, and reads the
 * result back. No dependencies: the script uses the built-in fetch and node:assert.
 *
 * The three things every adapter does:
 *   render(spec, ctx, host)           spec in, script text out. Pure: same spec, same script. No secrets in the text.
 *   execute(batch, env, opts, host)   run the scripts, return ONE result per script, in the same order.
 *   id, label, kinds, executable, runtime, needs, traits   what the platform needs to know about it.
 *
 * `host` is handed in by the platform (nothing to import): host.js() quotes text safely for a script, host.makeRunDir() gives a
 * fresh folder inside the run's scratch folder, host.runNode() starts Node with the platform's filtered environment, a time
 * limit and the cancel signal. Copy this folder to start another adapter (for example Selenium): change the id in both
 * plugin.json and here, replace renderScript(), and replace the part of execute() that reads the result.
 */
import fs from "node:fs/promises";
import path from "node:path";

const ID = "node-http-check";
const MAX_PARALLEL = 3;

// ── what runs inside the generated script ───────────────────────────────────

/**
 * The part of every script that is the same. It reads the address and the stored API token from the environment (the platform
 * puts them there for the run; they are never written into the script), and refuses to send a request to any other site.
 * Written with plain string concatenation so this file has no template literals inside template literals.
 */
const HEAD = [
    'import assert from "node:assert/strict";',
    'import fs from "node:fs";',
    "",
    'const base = new URL(process.env.API_BASE_URL || "");',
    'const token = process.env.API_TOKEN || "";',
    'const authHeader = process.env.API_AUTH_HEADER || "";',
    "const steps = [];",
    "const responses = [];",
    "let last;",
    "",
    "const fill = (text) => String(text).replace(/\\{\\{\\s*([A-Za-z0-9_.-]+)\\s*\\}\\}/g, (m, k) => (k in vars ? String(vars[k]) : m));",
    "const fillDeep = (v) => (typeof v === 'string' ? fill(v) : Array.isArray(v) ? v.map(fillDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x)])) : v);",
    "function at(value, dotPath) {",
    "    let cur = value;",
    "    for (const part of String(dotPath).split('.').filter(Boolean)) {",
    "        if (cur === null || cur === undefined) return undefined;",
    "        cur = cur[part];",
    "    }",
    "    return cur;",
    "}",
    "const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);",
    "",
    "async function send(method, rawPath, o) {",
    "    const target = new URL(fill(rawPath), base);",
    "    // Stored sign-in details only go to the API's own site.",
    "    if (target.origin !== base.origin) throw new Error('This test sends a request to another site (' + target.origin + '), which is not allowed.');",
    "    for (const [k, v] of Object.entries(o.query || {})) target.searchParams.set(k, fill(v));",
    "    const headers = {};",
    "    for (const [k, v] of Object.entries(o.headers || {})) headers[k] = fill(v);",
    "    if (o.auth) {",
    "        if (token) headers['Authorization'] = 'Bearer ' + token;",
    "        const i = authHeader.indexOf(':');",
    "        if (i > 0) headers[authHeader.slice(0, i).trim()] = authHeader.slice(i + 1).trim();",
    "    }",
    "    const hasBody = o.body !== undefined && method !== 'GET' && method !== 'HEAD';",
    "    const res = await fetch(target, { method, headers: hasBody ? Object.assign({ 'content-type': 'application/json' }, headers) : headers, body: hasBody ? JSON.stringify(fillDeep(o.body)) : undefined, redirect: 'manual' });",
    "    const text = await res.text();",
    "    let json;",
    "    try { json = JSON.parse(text); } catch { json = undefined; }",
    "    const out = {};",
    "    res.headers.forEach((v, k) => { out[k] = v; });",
    "    responses.push({ method, path: target.pathname, status: res.status });",
    "    return { status: res.status, headers: out, text, json };",
    "}",
].join("\n");

/** The part that runs the plan step by step and writes the result file. */
const MAIN = [
    "async function main() {",
    "    const started = Date.now();",
    "    let failedStepIndex = -1;",
    "    let error;",
    "    for (let i = 0; i < plan.length; i++) {",
    "        const [title, run] = plan[i];",
    "        try {",
    "            await run();",
    "            steps.push({ index: i, title, status: 'passed' });",
    "        } catch (e) {",
    "            // The first line only: node:assert appends a diff of the two values after the message.",
    "            const message = String(e && e.message ? e.message : e).split('\\n')[0].slice(0, 500);",
    "            steps.push({ index: i, title, status: 'failed', error: message });",
    "            failedStepIndex = i;",
    "            error = message;",
    "            break;",
    "        }",
    "    }",
    "    fs.writeFileSync(process.env.RESULT_FILE, JSON.stringify({ status: failedStepIndex < 0 ? 'passed' : 'failed', durationMs: Date.now() - started, error, failedStepIndex, steps, responses }));",
    "}",
    "main();",
    "",
].join("\n");

// ── render: spec in, script out ─────────────────────────────────────────────

const SUPPORTED_CHECKS = ["status", "statusClass", "statusBelow", "jsonPath", "jsonType", "header", "bodyContains", "bodyNotContains"];

/** A JSON value as JavaScript that rebuilds it, whatever the text holds (host.js quotes safely). */
const jsonExpr = (host, value) => (value === undefined ? "undefined" : "JSON.parse(" + host.js(JSON.stringify(value)) + ")");

function stepCode(step, host) {
    const lit = host.js;
    if (step.action === "request") {
        const title = step.method + " " + step.path;
        const extract = Object.entries(step.extract || {})
            .map(([name, p]) => "        { const v = at(last.json, " + lit(p) + "); if (v === undefined) throw new Error('Could not capture ' + " + lit(name) + " + ': nothing at ' + " + lit(p) + " + ' in the response.'); vars[" + lit(name) + "] = String(v); }\n")
            .join("");
        const body = "        last = await send(" + lit(step.method) + ", " + lit(step.path) + ", { query: " + jsonExpr(host, step.query) + ", headers: " + jsonExpr(host, step.headers) + ", body: " + jsonExpr(host, step.body) + ", auth: " + String(step.auth !== "none") + " });\n" + extract;
        return "    [" + lit(title) + ", async () => {\n" + body + "    }],\n";
    }
    if (step.action === "assertResponse") {
        if (!SUPPORTED_CHECKS.includes(step.check)) throw new Error('The check "' + step.check + '" is not supported by ' + ID + " (it supports: " + SUPPORTED_CHECKS.join(", ") + ").");
        const exp = step.expected;
        const p = step.path || "";
        let title;
        let code;
        switch (step.check) {
            case "status":
                title = "Check: status is " + Number(exp);
                code = "assert.equal(last.status, " + Number(exp) + ", 'Expected status " + Number(exp) + " but got ' + last.status);";
                break;
            case "statusClass": {
                const digit = Number(String(exp).charAt(0));
                title = "Check: status is " + digit + "xx";
                code = "assert.equal(Math.floor(last.status / 100), " + digit + ", 'Expected a " + digit + "xx status but got ' + last.status);";
                break;
            }
            case "statusBelow":
                title = "Check: status is below " + Number(exp);
                code = "assert.ok(last.status < " + Number(exp) + ", 'Expected a status below " + Number(exp) + " but got ' + last.status);";
                break;
            case "jsonPath":
                title = exp === undefined ? "Check: " + p + " exists" : "Check: " + p + " is " + exp;
                code =
                    exp === undefined
                        ? "assert.notEqual(at(last.json, " + lit(p) + "), undefined, 'Expected ' + " + lit(p) + " + ' to exist in the response');"
                        : "assert.equal(String(at(last.json, " + lit(p) + ")), fill(" + lit(String(exp)) + "), 'Expected ' + " + lit(p) + " + ' to be ' + fill(" + lit(String(exp)) + ") + ' but got ' + String(at(last.json, " + lit(p) + ")));";
                break;
            case "jsonType": {
                const target = p ? "at(last.json, " + lit(p) + ")" : "last.json";
                title = "Check: " + (p || "the response") + " is " + exp;
                code = "assert.equal(typeOf(" + target + "), " + lit(String(exp)) + ", 'Expected ' + " + lit(p || "the response") + " + ' to be of type ' + " + lit(String(exp)) + " + ' but it is ' + typeOf(" + target + "));";
                break;
            }
            case "header":
                title = "Check: header " + p + " contains " + exp;
                code = "assert.ok(String(last.headers[" + lit(p.toLowerCase()) + "] || '').includes(fill(" + lit(String(exp ?? "")) + ")), 'Expected the header ' + " + lit(p) + " + ' to contain ' + fill(" + lit(String(exp ?? "")) + "));";
                break;
            case "bodyContains":
                title = "Check: body contains " + exp;
                code = "assert.ok(last.text.includes(fill(" + lit(String(exp ?? "")) + ")), 'Expected the response body to contain ' + fill(" + lit(String(exp ?? "")) + "));";
                break;
            default:
                title = "Check: body does not contain " + exp;
                code = "assert.ok(!last.text.includes(fill(" + lit(String(exp ?? "")) + ")), 'Expected the response body not to contain ' + fill(" + lit(String(exp ?? "")) + "));";
        }
        return "    [" + lit(title) + ", async () => {\n        " + code + "\n    }],\n";
    }
    throw new Error('The step "' + step.action + '" is not supported by ' + ID + " (it runs API tests: request and assertResponse steps).");
}

function renderScript(spec, host) {
    if (spec.kind !== "api") throw new Error(ID + " runs API tests only.");
    const plan = spec.steps.map((s) => stepCode(s, host)).join("");
    return (
        "// " + spec.testId + ": generated by the " + ID + " plug-in. Change the test, not this file.\n" +
        HEAD +
        // The variables a test declares, plus {{unique}}; captured values are added while it runs.
        "\nconst vars = Object.assign({ unique: String(Date.now()) }, " + jsonExpr(host, spec.testData || {}) + ");\n" +
        "const plan = [\n" + plan + "];\n" +
        "\n" + MAIN
    );
}

// ── execute: run the scripts, read the results ──────────────────────────────

const tail = (text, n = 400) => String(text || "").trim().split("\n").slice(-6).join(" ").slice(-n);

async function runOne(script, dir, env, opts, host) {
    const file = path.basename(script.filename);
    const resultFile = path.join(dir, script.testId + ".result.json");
    const started = Date.now();
    const r = await host.runNode({
        cwd: dir,
        args: [file],
        // The platform's own secrets never reach the script; only these go in. The token is the project's stored API token.
        env: { API_BASE_URL: env.run.apiBaseUrl || env.run.baseUrl, API_TOKEN: env.run.apiToken || "", API_AUTH_HEADER: env.run.apiAuthHeader || "", RESULT_FILE: resultFile },
        timeoutMs: Math.min(opts.testTimeoutMs ?? 60_000, 300_000),
        signal: opts.signal,
    });
    if (r.aborted) throw new Error("Job cancelled");
    const base = { testId: script.testId, durationMs: Date.now() - started, failedStepIndex: -1, steps: [], artifacts: [], responses: [] };
    if (r.timedOut) return { ...base, status: "timedOut", error: "The test did not finish in time and was stopped." };
    let result;
    try {
        result = JSON.parse(await fs.readFile(resultFile, "utf8"));
    } catch {
        // The script died before it could write its result (a syntax error, a crash): say so with the last of what it printed.
        return { ...base, status: "error", error: "The script stopped before it reported a result. " + tail(r.stderr || r.stdout) };
    }
    return {
        testId: script.testId,
        status: result.status === "passed" ? "passed" : "failed",
        durationMs: result.durationMs,
        error: result.error,
        failedStepIndex: result.failedStepIndex,
        steps: result.steps,
        artifacts: [],
        responses: result.responses,
    };
}

async function execute(batch, env, opts, host) {
    const dir = await host.makeRunDir();
    for (const s of batch.scripts) await fs.writeFile(path.join(dir, path.basename(s.filename)), s.content);
    const results = new Array(batch.scripts.length);
    let next = 0;
    const worker = async () => {
        while (next < batch.scripts.length) {
            const i = next++;
            results[i] = await runOne(batch.scripts[i], dir, env, opts, host);
        }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, batch.scripts.length) }, worker));
    return results;
}

export default {
    id: ID,
    label: "Node HTTP check (example plug-in)",
    kinds: ["api"],
    executable: true,
    runtime: ID,
    needs: { node: true },
    traits: { visionJudgement: false, cleanupLedger: false, browserRepair: false },
    render(spec, ctx, host) {
        return { framework: ID, filename: spec.testId + "." + ID + ".mjs", content: renderScript(spec, host), language: "typescript" };
    },
    execute,
};
