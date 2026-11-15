// Who holds the machine-wide locks and each checkout's web/dist guard (scripts/lock.mjs):  node scripts/lock-status.mjs
import { ago, describeHolder, lockDir, lockStatus } from "./lock.mjs";

let status;
try {
    status = lockStatus();
} catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
}
const flag = (h) => `; last heartbeat ${ago(h.beatAgeMs)} ago${h.stale ? " (abandoned: the next taker clears it)" : ""}`;
console.log(`Locks in ${lockDir()}:`);
if (!status.locks.length && !status.dists.length) console.log("  none held");
for (const h of status.locks) console.log(`  ${h.name.padEnd(8)} ${describeHolder(h)}${flag(h)}`);
for (const d of status.dists) {
    console.log(`  dist     web/dist of ${d.checkout || "(unknown checkout)"}:`);
    if (d.writer) console.log(`    web build ${d.readers.length ? "waiting for the readers below" : "replacing it"}: ${describeHolder(d.writer)}${flag(d.writer)}`);
    for (const r of d.readers) console.log(`    reading: ${describeHolder(r)}${flag(r)}`);
}
