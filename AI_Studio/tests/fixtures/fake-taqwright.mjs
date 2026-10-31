// Stand-in for the Taqwright CLI, used only by tests/mobile.test.ts so the platform's mobile plumbing
// (config, environment, report parsing, persistence) can be tested without an emulator.
// It "runs" each *.spec.ts in the working directory: steps whose title contains "[fail]" fail.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cwd = process.cwd();
fs.writeFileSync(
    path.join(os.tmpdir(), "aitp-fake-taqwright-observed.json"),
    JSON.stringify({ args: process.argv.slice(2), env: process.env, config: fs.readFileSync(path.join(cwd, "taqwright.config.ts"), "utf8") }),
);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const specs = [];
for (const file of fs.readdirSync(cwd).filter((f) => f.endsWith(".spec.ts"))) {
    const src = fs.readFileSync(path.join(cwd, file), "utf8");
    const titles = [...src.matchAll(/test\.step\(("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]));
    const failIndex = titles.findIndex((t) => t.includes("[fail]"));
    const video = path.join(cwd, `${file}.mp4`);
    fs.writeFileSync(video, "not really a video");
    const steps = titles.slice(0, failIndex === -1 ? titles.length : failIndex + 1).map((title, i) => ({ title, duration: 5, ...(i === failIndex ? { error: { message: `expect(locator).toBeVisible() failed\n  Locator: ${title}` } } : {}) }));
    const failed = failIndex !== -1;
    specs.push({
        title: file,
        file,
        tests: [
            {
                status: failed ? "unexpected" : "expected",
                results: [
                    {
                        status: failed ? "failed" : "passed",
                        duration: 1234,
                        steps,
                        ...(failed ? { error: { message: "step failed" } } : {}),
                        attachments: failed
                            ? [
                                  { name: "screenshot", contentType: "image/png", body: PNG.toString("base64") },
                                  { name: "taqwright-video", contentType: "video/mp4", path: video },
                                  { name: "taqwright-trace", contentType: "text/html", path: video },
                              ]
                            : [],
                    },
                ],
            },
        ],
    });
}
fs.writeFileSync(path.join(cwd, "report.json"), JSON.stringify({ suites: [{ file: "x", specs, suites: [] }], errors: [] }));
