// Which test file belongs to which tier. Computed from the files themselves, so a new test file lands in a tier without a list to keep:
//   fast     the files named in vitest.fast.config.ts (no browser; run in parallel)
//   phone    files that drive the fake phone tooling (fake adb/emulator/Taqwright/xcrun) or are named phone-*, mobile-*, device-*, ios*
//   browser  everything else (browsers, platform servers, the agent program, desktop windows); one file at a time
// `node scripts/test-tiers.mjs` prints the tiers; `node scripts/test-tiers.mjs phone` prints one tier's files.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PHONE_NAME = /^(phone|mobile|device|ios)[-.]/;
const PHONE_TOOLING = /fake-adb|fake-emulator|fake-taqwright|fake-xcrun|memory-device|phone-fake-api|phone-model|AITP_ADB_PATH|AITP_EMULATOR_PATH/;

/** The files listed in the fast config (its `include` strings). */
export function fastFiles(root = ROOT) {
    const text = fs.readFileSync(path.join(root, "vitest.fast.config.ts"), "utf8");
    return [...new Set([...text.matchAll(/["'](tests\/[^"'*]+\.test\.ts)["']/g)].map((m) => m[1]))].sort();
}

/** Every test file the default config runs (tests/**\/*.test.ts), as forward-slash paths relative to the repository. */
export function allFiles(root = ROOT) {
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
            const rel = `${dir}/${e.name}`;
            if (e.isDirectory()) {
                if (e.name !== "fixtures" && e.name !== "node_modules") walk(rel);
            } else if (e.name.endsWith(".test.ts")) out.push(rel);
        }
    };
    walk("tests");
    return out.sort();
}

export function tiers(root = ROOT) {
    const all = allFiles(root);
    const fastSet = new Set(fastFiles(root));
    const fast = all.filter((f) => fastSet.has(f));
    const missingFast = [...fastSet].filter((f) => !all.includes(f));
    const rest = all.filter((f) => !fastSet.has(f));
    const phone = rest.filter((f) => PHONE_NAME.test(path.basename(f)) || PHONE_TOOLING.test(fs.readFileSync(path.join(root, f), "utf8")));
    const phoneSet = new Set(phone);
    const browser = rest.filter((f) => !phoneSet.has(f));
    return { all, fast, phone, browser, missingFast };
}

export function tierOf(file, t = tiers()) {
    return t.fast.includes(file) ? "fast" : t.phone.includes(file) ? "phone" : "browser";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const t = tiers();
    const want = process.argv[2];
    if (want) {
        if (!(want in t)) {
            console.error(`Unknown tier "${want}". Use fast, phone, browser or all.`);
            process.exit(2);
        }
        console.log(t[want].join("\n"));
    } else {
        console.log(`fast ${t.fast.length}, phone ${t.phone.length}, browser ${t.browser.length}, all ${t.all.length}`);
        console.log(`phone: ${t.phone.join(", ")}`);
        if (t.missingFast.length) console.log(`listed in vitest.fast.config.ts but missing: ${t.missingFast.join(", ")}`);
    }
}
