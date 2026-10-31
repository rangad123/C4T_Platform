import { useCallback, useState } from "react";
import { dapi, errorText, parseText, type ParseAnswer, type PrintAnswer } from "./dsl";

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** The text view of the step editor: the text being edited, what it was when it was opened, and the two ways across (steps to text, text to steps). */
export function useTextDraft() {
    const [text, setText] = useState("");
    const [base, setBase] = useState("");
    const [printed, setPrinted] = useState<PrintAnswer | null>(null);
    const [busy, setBusy] = useState(false);

    /** Writes the steps as text. Asked again once when the platform says it is busy (429). */
    const enter = useCallback(async (spec: unknown): Promise<{ ok: true } | { ok: false; message: string }> => {
        setBusy(true);
        try {
            let r: PrintAnswer;
            try {
                r = await dapi<PrintAnswer>("/dsl/print", { method: "POST", body: { spec } });
            } catch (e) {
                if ((e as { status?: number }).status !== 429) throw e;
                await sleep(1100);
                r = await dapi<PrintAnswer>("/dsl/print", { method: "POST", body: { spec } });
            }
            setPrinted(r);
            setText(r.text);
            setBase(r.text);
            return { ok: true };
        } catch (e) {
            return { ok: false, message: errorText(e) };
        } finally {
            setBusy(false);
        }
    }, []);

    /** Reads the text as steps. `spec` is null when the text does not read yet, with the first problem in words. */
    const leave = useCallback(async (): Promise<{ answer: ParseAnswer } | { message: string }> => {
        setBusy(true);
        try {
            let answer: ParseAnswer;
            try {
                answer = await parseText(text);
            } catch (e) {
                if ((e as { status?: number }).status !== 429) throw e;
                await sleep(1100);
                answer = await parseText(text);
            }
            return { answer };
        } catch (e) {
            return { message: errorText(e) };
        } finally {
            setBusy(false);
        }
    }, [text]);

    const discard = useCallback(() => setText(base), [base]);

    return { text, setText, base, dirty: text !== base, printed, busy, enter, leave, discard, rebase: (t: string) => (setText(t), setBase(t)) };
}
export type TextDraft = ReturnType<typeof useTextDraft>;
