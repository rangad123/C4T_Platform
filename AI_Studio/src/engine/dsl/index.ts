/** Text tests: a deterministic, line-per-step text format for a test (no model, no network). See docs/features/text-tests.md. */
export { PHRASES, HEADER_INFO, HEADER_KEYS, phraseReference, readableTemplate, type PhraseDef } from "./grammar.js";
export { DSL_LIMITS, parseDsl, readStepLine, type DslDiagnostic, type ParseResult } from "./parser.js";
export { comparableSpec, normalizeStep, printSpec, printStep, type PrintResult } from "./printer.js";
export { quote, tokenize } from "./lexer.js";
