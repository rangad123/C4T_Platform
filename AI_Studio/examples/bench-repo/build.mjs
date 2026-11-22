#!/usr/bin/env node
// The PR bench's repository (testing-engine Phase 6, spec §6.2): a local git repository of bench-shop and bench-rbac in which every pull
// request is one real code change on its own branch. Nothing here talks to a network; git runs with no user or system configuration.
//
//   node examples/bench-repo/build.mjs <empty or missing folder>
//
// It writes the repository there and `prs.json` beside its .git (the manifest the bench reads, src/eval/bench/change/run.ts), in the order
// the bench runs them. Per seeded defect, in source order (bench-shop's 12, then bench-rbac's 8):
//   seed   from main: every line naming on("<id>") has it replaced by `true` (the defect is in the code, the app runs with no switches);
//   claim  from the seed branch: a comment only, titled "Fixes #<issue>": a fix claim that does not fix;
//   fix    from the seed branch: back to main's code, titled "Fixes #<issue>".
// Then from main: 3 refactors (no behaviour change), 1 decoy (a rename whose names look like routes) and 1 change in an unmapped file.
// Authors and dates are fixed, so the same sources give the same commit ids.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EXAMPLES = path.join(import.meta.dirname, "..");
const APPS = ["bench-shop", "bench-rbac"];
/** Files of main besides the apps: a helper nothing imports (the decoy renames it) and a stand-alone tool (the unmapped change). */
const EXTRA = {
    "examples/bench-shop/cart.mjs": "// Formats a cart line for the order e-mail. Not used by the server yet.\nexport function cartLine(line) {\n    return `${line.quantity} x ${line.name}`;\n}\n",
    "examples/bench-shop/tools/export-orders.mjs": "// Writes the orders of a JSON dump as CSV lines (an operator's tool, run by hand).\nexport function toCsv(orders) {\n    return orders.map((o) => [o.id, o.status, o.total].join(\",\")).join(\"\\n\");\n}\n",
};

/** Every seed id an app's source names, in file order (the same rule as tests/fixtures/seed-prs.ts). */
export function seedIds(source) {
    return [...new Set([...source.matchAll(/\bon\("(B[SR]-\d+)"\)/g)].map((m) => m[1]))];
}
/** The source with one seed turned on in code: every `on("<id>")` becomes `true`. */
export const seedOn = (source, id) => source.split(`on("${id}")`).join("true");

/** The refactors: no behaviour change, each in a different place. */
const REFACTORS = [
    { app: "bench-shop", title: "Name the amount after the discount", from: /\bafterDiscount\b/g, to: "net" },
    { app: "bench-shop", title: "Explain the order limit", from: "const MAX_PER_ITEM = 10;", to: "// The most of one item a cart may hold (requirement 3.6).\nconst MAX_PER_ITEM = 10;" },
    { app: "bench-rbac", title: "Spell out the write check", from: "const canWrite = (u, n) =>", to: "const canWrite = (u, note) =>", also: [["n.ownerId === u.id || on(\"BR-02\")", "note.ownerId === u.id || on(\"BR-02\")"]] },
];

export function build(out) {
    if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} is not empty`);
    fs.mkdirSync(out, { recursive: true });
    const env = { PATH: process.env.PATH ?? "", HOME: out, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Bench", GIT_AUTHOR_EMAIL: "bench@example.test", GIT_COMMITTER_NAME: "Bench", GIT_COMMITTER_EMAIL: "bench@example.test" };
    let tick = 0;
    const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: out, env: { ...env, GIT_AUTHOR_DATE: `2026-11-01T10:00:${String(tick).padStart(2, "0")}Z`, GIT_COMMITTER_DATE: `2026-11-01T10:00:${String(tick).padStart(2, "0")}Z` }, encoding: "utf8" }).trim();
    const write = (files) => {
        for (const [p, text] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(out, p)), { recursive: true });
            fs.writeFileSync(path.join(out, p), text);
        }
    };
    const commit = (message) => {
        tick = (tick + 1) % 60;
        git("add", "-A");
        git("commit", "-q", "--allow-empty", "-m", message);
        return git("rev-parse", "HEAD");
    };
    git("init", "-q", "-b", "main");
    const main = {};
    for (const app of APPS) {
        main[`examples/${app}/server.mjs`] = fs.readFileSync(path.join(EXAMPLES, app, "server.mjs"), "utf8");
        main[`examples/${app}/requirements/requirements.md`] = fs.readFileSync(path.join(EXAMPLES, app, "requirements", "requirements.md"), "utf8");
    }
    Object.assign(main, EXTRA);
    write(main);
    const base = commit("The bench apps");

    const prs = [];
    const branch = (name, from, files, message, extra) => {
        git("checkout", "-q", "-b", name, from.sha);
        for (const p of extra?.remove ?? []) fs.rmSync(path.join(out, p));
        write(files);
        const sha = commit(message);
        git("checkout", "-q", "main");
        const pr = { number: prs.length + 1, branch: name, title: message, base: from.sha, head: sha, ...extra?.meta };
        prs.push(pr);
        return { sha, pr };
    };
    let issue = 100;
    for (const app of APPS) {
        const file = `examples/${app}/server.mjs`;
        for (const seed of seedIds(main[file])) {
            const n = ++issue;
            const on = branch(`seed/${seed}`, { sha: base }, { [file]: seedOn(main[file], seed) }, `${app}: change ${seed}`, { meta: { kind: "seed", app, seed } });
            branch(`claim/${seed}`, on, { [file]: `${seedOn(main[file], seed)}// Reviewed after ${seed}.\n` }, `${app}: tidy up after ${seed} (Fixes #${n})`, { meta: { kind: "claim", app, seed, issue: n } });
            branch(`fix/${seed}`, on, { [file]: main[file] }, `${app}: put ${seed} right (Fixes #${n})`, { meta: { kind: "fix", app, seed, issue: n } });
        }
    }
    for (const [i, r] of REFACTORS.entries()) {
        const file = `examples/${r.app}/server.mjs`;
        let text = main[file].replace(r.from, r.to);
        for (const [a, b] of r.also ?? []) text = text.replace(a, b);
        if (text === main[file]) throw new Error(`refactor ${i + 1} changes nothing`);
        branch(`refactor/${i + 1}`, { sha: base }, { [file]: text }, `${r.app}: ${r.title.toLowerCase()}`, { meta: { kind: "refactor", app: r.app } });
    }
    // The decoy: the unused helper renamed to a route-like file, its function named like a route handler; no route calls it.
    branch("decoy/rename", { sha: base }, { "examples/bench-shop/cart-routes.mjs": EXTRA["examples/bench-shop/cart.mjs"].replace("export function cartLine", "export function postApiCartItems") }, "bench-shop: move the cart line helper", { remove: ["examples/bench-shop/cart.mjs"], meta: { kind: "decoy", app: "bench-shop" } });
    branch("unmapped/tool", { sha: base }, { "examples/bench-shop/tools/export-orders.mjs": EXTRA["examples/bench-shop/tools/export-orders.mjs"].replace("o.total]", "o.total, o.placedAt]") }, "bench-shop: add the date to the order export", { meta: { kind: "unmapped", app: "bench-shop" } });
    const manifest = { format: 1, main: base, prs };
    fs.writeFileSync(path.join(out, "prs.json"), JSON.stringify(manifest, null, 2) + "\n");
    return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
    const out = process.argv[2];
    if (!out) {
        console.error("usage: node examples/bench-repo/build.mjs <empty or missing folder>");
        process.exit(2);
    }
    const m = build(path.resolve(out));
    console.log(`${m.prs.length} pull requests in ${path.resolve(out)} (main ${m.main.slice(0, 7)})`);
}
