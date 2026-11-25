/**
 * How a structured answer gives an object whose keys are not known in advance. Anthropic compiles the schema into a grammar that can only
 * give `{}` for such an object (a record, or z.unknown()'s object form): the keys must be listed. So the model is asked for a list of
 * { name, value } pairs, or for JSON text, and the answer is turned back into the object here (tests/llm-schema-limits-unit.test.ts).
 */
import { z } from "zod";

/** A list of { name, value } pairs standing for an object with free keys. */
export const pairs = <V extends z.ZodTypeAny>(value: V, max = 30) => z.array(z.object({ name: z.string().min(1).max(100), value })).max(max);

/** The object the pairs stand for (a later pair of the same name wins). */
export const recordOf = <V>(list: ReadonlyArray<{ name: string; value: V }>): Record<string, V> => Object.fromEntries(list.map((p) => [p.name, p.value]));

/** JSON text, refused (so asked again) unless it parses; with `object`, only a JSON object. */
export const jsonText = (max: number, object = false) =>
    z
        .string()
        .max(max)
        .superRefine((text, ctx) => {
            let v: unknown;
            try {
                v = JSON.parse(text);
            } catch {
                return ctx.addIssue({ code: "custom", message: "is not valid JSON" });
            }
            if (object && (typeof v !== "object" || v === null || Array.isArray(v))) ctx.addIssue({ code: "custom", message: "is not a JSON object" });
        });
