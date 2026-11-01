// Reads one .docx or .pdf in a separate process (extract.ts starts it with a memory limit and a timeout), so a file built to
// exhaust memory or time ends this process, never the server. Plain JavaScript: it runs without the TypeScript loader.
// In: { kind: "docx" | "pdf", data: Uint8Array } over IPC. Out: { ok: true, value } or { ok: false, message }.
process.once("message", async (msg) => {
    let answer;
    try {
        if (msg.kind === "pdf") {
            const { extractText } = await import("unpdf");
            const { text } = await extractText(new Uint8Array(msg.data), { mergePages: true });
            answer = { ok: true, value: Array.isArray(text) ? text.join("\n") : String(text) };
        } else {
            const mammoth = (await import("mammoth")).default;
            const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(msg.data) });
            answer = { ok: true, value };
        }
    } catch (e) {
        answer = { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    process.send(answer, () => process.exit(0));
});
