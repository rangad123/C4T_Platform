// Stand-in for `xcrun`, used only by tests/ios.test.ts (IOS_XCRUN_CLI): it answers `simctl list|boot|bootstatus|shutdown` from a state file in the
// temp folder and writes down every call, so a test can check which simulator was started and which was stopped. Nothing real is touched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const file = path.join(os.tmpdir(), "aitp-fake-xcrun-state.json");
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
state.calls = [...(state.calls ?? []), args];
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const find = (udid) => Object.values(state.devices).flat().find((d) => d.udid === udid);
const [tool, verb, a1] = args;
let code = 0;
if (tool !== "simctl") {
    code = 2;
} else if (verb === "list") {
    if (state.failList) {
        process.stderr.write("xcrun: error: unable to find utility \"simctl\"\n");
        code = 72;
    } else process.stdout.write(JSON.stringify({ devices: state.devices }));
} else if (verb === "boot") {
    const d = find(a1);
    if (!d || state.failBoot) {
        process.stderr.write("Unable to boot device\n");
        code = 164;
    } else d.state = "Booted";
} else if (verb === "bootstatus") {
    if (state.failBootstatus) {
        process.stderr.write("Boot status check failed\n");
        code = 1;
    }
} else if (verb === "shutdown") {
    const d = find(a1);
    if (d) d.state = "Shutdown";
} else code = 2;
save();
process.exit(code);
