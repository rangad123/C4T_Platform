// Stand-in for the Taqwright CLI used by tests/phone-reliability.test.ts (never a real Appium run). The runner gives its child only a few environment
// variables, so the settings come from a file: <tmp>/aitp-fake-tq-steps.json = { missing: ["signin_old"], log: "<file>", observed: "<file>" }.
// It "runs" each *.spec.ts in the working directory: a step whose code names a value listed in `missing` fails the way Taqwright reports an element it
// never found; every other step passes. Each run appends ["taqwright", <spec files>] to `log` (the same file the fake adb logs to, so a test sees the
// order of adb calls and runs) and each script to `observed` (JSON lines).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cwd = process.cwd();
let cfg = {};
try {
    cfg = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), "aitp-fake-tq-steps.json"), "utf8"));
} catch {
    /* no settings: every step passes */
}
const missing = Array.isArray(cfg.missing) ? cfg.missing : [];
const files = fs.readdirSync(cwd).filter((f) => f.endsWith(".spec.ts"));
if (cfg.log) fs.appendFileSync(cfg.log, JSON.stringify(["taqwright", ...files]) + "\n");

const specs = [];
for (const file of files) {
    const src = fs.readFileSync(path.join(cwd, file), "utf8");
    if (cfg.observed) fs.appendFileSync(cfg.observed, JSON.stringify({ file, content: src }) + "\n");
    const steps = [];
    let error;
    for (const m of src.matchAll(/await test\.step\(("(?:[^"\\]|\\.)*"), async \(\) => \{\r?\n([\s\S]*?)\r?\n {4}\}\);/g)) {
        const title = JSON.parse(m[1]);
        const code = m[2];
        const gone = missing.find((v) => code.includes(JSON.stringify(v)));
        if (gone) {
            const using = /getByTestId\(/.test(code) ? "id" : /getByLabel\(/.test(code) ? "accessibility id" : "-android uiautomator";
            error = `waitFor: locator (${using}=${gone}) did not reach state "visible" within 15000ms`;
            steps.push({ title, duration: 5, error: { message: error } });
            break;
        }
        steps.push({ title, duration: 5 });
    }
    specs.push({ title: file, file, tests: [{ status: error ? "unexpected" : "expected", results: [{ status: error ? "failed" : "passed", duration: 100, steps, ...(error ? { error: { message: error } } : {}), attachments: [] }] }] });
}
fs.writeFileSync(path.join(cwd, "report.json"), JSON.stringify({ suites: [{ file: "x", specs, suites: [] }], errors: [] }));
