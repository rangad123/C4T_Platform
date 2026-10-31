// Entry of the process that runs one task's scripts. TypeScript, loaded through tsx like the other entry points.
import { register } from "tsx/esm/api";

register();
await import("./task-child.ts");
