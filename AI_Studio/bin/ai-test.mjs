#!/usr/bin/env node
// `ai-test` command: the CLI is TypeScript, run through tsx like the platform's other entry points.
import { register } from "tsx/esm/api";

register();
await import("../src/cli/index.ts");
