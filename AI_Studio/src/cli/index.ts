// Program entry for `npm run ai-test` and the `ai-test` bin: run the command, then exit with its code.
import { main } from "./main.js";

const code = await main(process.argv.slice(2), { env: process.env, out: (l) => console.log(l), err: (l) => console.error(l) });
// Not process.exit(): on Windows, exiting while HTTP connections are still closing can abort the process with a
// garbled exit code (0xC0000409), and a pipeline reads that code. Let the event loop drain; the timer is only a
// safety net for something that refuses to let go (it is unref'd, so it never delays a clean exit).
process.exitCode = code;
setTimeout(() => process.exit(code), 8000).unref();
