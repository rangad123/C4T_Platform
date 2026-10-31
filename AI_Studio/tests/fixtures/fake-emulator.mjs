// A stand-in for the Android `emulator` program (AITP_EMULATOR_PATH): "boots" a device into the fake adb's state file and stays alive until the fake adb
// removes it (`adb -s emulator-5554 emu kill`), like a real emulator process. Prints its pid into the state so tests can check it is gone.
//
// It shares the state file with tests/fixtures/fake-adb.mjs and follows the same rules (see the comment there): it writes under the same lock file
// through a temporary file and a rename, and a state it cannot read right now is NOT taken as "my device is gone" (that once made it exit early while
// an adb call was rewriting the file, and the test's kill(pid, 0) threw ESRCH). It exits only when a state it could read no longer lists its device.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_FILE = process.env.AITP_FAKE_STATE || path.join(os.tmpdir(), "aitp-fake-adb-state.json");
const LOCK_FILE = STATE_FILE + ".lock";
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const args = process.argv.slice(2);
const avd = args[args.indexOf("-avd") + 1] || "Fake_AVD";

/** The state, a fresh one when there is none yet, or undefined when the file is there but cannot be read right now. */
const read = () => {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch (e) {
        if (e && e.code === "ENOENT") return { devices: [], installed: ["com.example.shop", "com.example.notes"], fg: null, app: null, dumps: 0, injected: [], typed: [], taps: [], killed: false };
        return undefined;
    }
};
function withLock(fn) {
    for (let i = 0; ; i++) {
        try {
            fs.closeSync(fs.openSync(LOCK_FILE, "wx"));
            break;
        } catch (e) {
            if (e.code !== "EEXIST" && e.code !== "EPERM" && e.code !== "EACCES" && e.code !== "EBUSY") throw e;
        }
        try {
            if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > 3000) fs.rmSync(LOCK_FILE, { force: true });
        } catch {
            /* gone meanwhile */
        }
        pause(i < 50 ? 2 : 10);
    }
    try {
        return fn();
    } finally {
        fs.rmSync(LOCK_FILE, { force: true });
    }
}

if (process.env.AITP_FAKE_EMULATOR_FAILS === "1") {
    process.stderr.write("PANIC: Missing emulator engine program for 'x86_64' CPU.\n");
    process.exit(1);
}
withLock(() => {
    let s;
    for (let i = 0; !(s = read()) && i < 200; i++) pause(10);
    if (!s) throw new Error("fake emulator: the state file could not be read");
    s.devices = s.devices.filter((d) => d.serial !== "emulator-5554");
    s.devices.push({ serial: "emulator-5554", state: "device", emulator: true, avd });
    s.emulatorPid = process.pid;
    s.emulatorStarts = (s.emulatorStarts || 0) + 1;
    s.killed = false;
    const tmp = STATE_FILE + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(s));
    for (let i = 0; ; i++) {
        try {
            fs.renameSync(tmp, STATE_FILE);
            break;
        } catch (e) {
            if (i >= 200 || (e.code !== "EPERM" && e.code !== "EACCES" && e.code !== "EBUSY")) throw e;
            pause(10);
        }
    }
});
setInterval(() => {
    const s = read();
    if (s && !s.devices.some((d) => d.serial === "emulator-5554")) process.exit(0);
}, 150);
