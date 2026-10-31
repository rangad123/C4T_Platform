// Entry of the process that hosts one recording session on this computer. TypeScript, loaded through tsx like the other entry points.
import { register } from "tsx/esm/api";

register();
await import("./record-child.ts");
