/** The file to open is the thing to find in the folder, so it is set in bold; a word in `backticks` is something to type, set in a code face. */
export function boldScripts(text: string, boldFiles = true) {
    return text.split(/(start-runner\.(?:command|cmd|sh)|check-computer\.(?:command|cmd)|AITestingRunnerSetup\.exe|ai-testing-runner-mac\.pkg|“AI Testing Runner”|`[^`]+`)/).map((part, i) => {
        if (i % 2 === 0) return part;
        if (part.startsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
        return boldFiles ? <b key={i}>{part}</b> : part;
    });
}
