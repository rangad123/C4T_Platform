// Does the configured AI model accept images?  Sends ONE real request carrying a 1-pixel picture and reports yes / no.
//
//   npx tsx --env-file-if-exists=.env scripts/vision-probe.mjs
//
// It costs a fraction of a cent, is never run by the test suite (tests use scripted model doubles), and needs the same
// LLM_PROVIDER / LLM_MODEL / API key settings the platform uses. Exit code: 0 = the model accepted the image,
// 1 = it did not (or could not be reached), 2 = no model is configured. Keys are never printed.
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { assertLlmConfigured, createLlmClient } from "../src/engine/llm/provider.js";
import { describeModelFailure } from "../src/engine/vision/verdict.js";

// A valid 1x1 PNG.
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const cfg = loadConfig();
try {
    assertLlmConfigured(cfg);
} catch (e) {
    console.error(`No model is configured: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
}

const client = createLlmClient(cfg);
console.log(`Asking ${cfg.LLM_PROVIDER} / ${client.modelName} to look at a 1x1 picture...`);
try {
    const answer = await client.imageObject({
        system: "You are testing whether you can receive images. Answer only with the structured result.",
        prompt: "An image is attached. Set sawImage to true if you received a picture, and say in one or two words what colour it is.",
        images: [{ data: PIXEL, mediaType: "image/png" }],
        schema: z.object({ sawImage: z.boolean(), colour: z.string().max(40) }),
        temperature: 0,
        maxOutputTokens: 60,
    });
    console.log(`The model answered: ${JSON.stringify(answer)}`);
    if (answer.sawImage) {
        console.log("RESULT: this model accepts images. AI judgement can be switched on.");
        process.exit(0);
    }
    console.log("RESULT: the call worked but the model says it did not receive a picture. Choose a vision-capable model.");
    process.exit(1);
} catch (e) {
    console.log(`RESULT: no. AI judgement could not run: ${describeModelFailure(e)}`);
    process.exit(1);
}
