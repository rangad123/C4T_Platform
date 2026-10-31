/**
 * Windows desktop tests: what a spec may say about the application it drives.
 *
 * SECURITY. A spec is user input, and starting a program on a computer is a new power. The rules here are the first of
 * two layers (the second is the allow-list kept by the computer that runs the test, see ./policy.ts and ./helper.ts):
 *
 *  - `app` is either a bare program name (`calc.exe`) or an absolute drive path (`C:\Program Files\Tool\tool.exe`). Never
 *    a relative path, a UNC path (`\\server\share`), a URL, a path with `..`, or anything with characters a shell treats
 *    specially. Only `.exe` programs.
 *  - Command shells, script hosts, interpreters and well-known "living off the land" programs are denied by name, always:
 *    putting one on an allow-list by mistake does not make it launchable (`DESKTOP_DENIED_PROGRAMS`).
 *  - `args` are plain data, one string each. They are never joined into a shell line: the program is started without a shell
 *    and the arguments are quoted for the Windows command line by the helper.
 *
 * Nothing here touches the machine; it is all pure text checks.
 */
import { z } from "zod";

/**
 * Programs a test may never start, whatever an allow-list says. Matched against the program's file name without `.exe`
 * (case-insensitive), both on the name in the spec and on the real file the name resolves to.
 */
export const DESKTOP_DENIED_PROGRAMS: readonly string[] = [
    // command shells and script hosts
    "cmd", "command", "powershell", "powershell_ise", "pwsh", "wscript", "cscript", "mshta", "wsl", "wslhost", "bash", "sh", "zsh", "fish",
    // interpreters and runtimes that run whatever they are told
    "node", "nodejs", "deno", "bun", "npm", "npx", "python", "python3", "pythonw", "py", "pyw", "perl", "ruby", "php", "java", "javaw", "lua", "wish", "tclsh",
    // Windows programs that load or run arbitrary code or commands
    "rundll32", "regsvr32", "regsvcs", "regasm", "installutil", "msbuild", "msiexec", "msconfig", "odbcconf", "ieexec", "mavinject", "presentationhost", "syncappvpublishingserver",
    "forfiles", "pcalua", "schtasks", "at", "wmic", "csc", "vbc", "jsc", "ilasm", "cmstp", "control", "hh", "xwizard", "infdefaultinstall", "runonce", "bash",
    // download, transfer and remote access tools
    "certutil", "bitsadmin", "curl", "wget", "ftp", "tftp", "ssh", "scp", "sftp", "telnet", "nc", "ncat", "netsh", "mstsc",
    // administration of the machine
    "reg", "regedit", "sc", "net", "net1", "taskkill", "tskill", "takeown", "icacls", "cacls", "runas", "psexec", "psexec64", "explorer", "start", "conhost", "mmc", "eventvwr", "gpedit", "diskpart", "bcdedit", "shutdown", "logoff",
];

const DENIED = new Set(DESKTOP_DENIED_PROGRAMS);

/** File extensions that are scripts, shortcuts or installers: never a program a test starts (only `.exe` is). */
const FORBIDDEN_EXTENSIONS = /\.(?:bat|cmd|vbs|vbe|js|jse|wsf|wsh|ps1|psm1|psd1|msc|hta|lnk|scr|com|cpl|jar|msi|msp|reg|dll|sys|url|appref-ms|application|gadget|inf)$/i;

/** Windows device names: opening one as a program would be odd at best. */
const DEVICE_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export const DESKTOP_STARTUP_DEFAULT_MS = 15_000;
export const DESKTOP_STARTUP_MAX_MS = 60_000;
export const DESKTOP_MAX_ARGS = 20;

const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
/** Characters that mean something to a shell or to the command line. They have no place in a program name. */
const APP_CHARS = /^[\p{L}\p{N} ._()\-\\/:]+$/u;
/** In an argument: control characters and the characters a shell treats specially. Text such as `--mode=fast` or `C:\data\a.txt` is fine. */
const ARG_BAD = /[\u0000-\u001f\u007f&|;<>^%"'`$\u2028\u2029]/;

/** The file name of a program without folders and without `.exe`, lower case. */
export function programName(app: string): string {
    const base = app.split(/[\\/]/).pop() ?? "";
    return base.replace(/\.exe$/i, "").toLowerCase();
}

/** True when this program is on the hard deny-list. */
export function isDeniedProgram(app: string): boolean {
    return DENIED.has(programName(app));
}

/** Why a program name or path is not acceptable, in plain words, or undefined when it is. Pure text checks. */
export function appProblem(app: string): string | undefined {
    if (typeof app !== "string" || app.trim() === "") return "Name the application to start.";
    if (app !== app.trim()) return "The application name has spaces at the start or end.";
    if (app.length > 260) return "The application path is too long.";
    if (CONTROL.test(app)) return "The application name has control characters.";
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(app)) return "The application must be a program name or a path on this computer, not a web address.";
    if (/^(?:\\\\|\/\/)/.test(app)) return "The application can't be on a network share (\\\\server\\share). Install it on this computer.";
    if (!APP_CHARS.test(app)) return "The application name has characters that aren't allowed. Use letters, digits, spaces and . _ - ( ) \\ / only.";
    // A colon is only allowed as the drive letter of an absolute path.
    const absolute = /^[A-Za-z]:[\\/]/.test(app);
    if (app.includes(":") && !absolute) return "The application must be a program name (calc.exe) or an absolute path (C:\\Program Files\\Tool\\tool.exe).";
    if (absolute && app.slice(2).includes(":")) return "The application path has a colon that isn't part of the drive letter.";
    if (!absolute && /[\\/]/.test(app)) return "Give a program name (calc.exe) or a full path starting with a drive letter (C:\\...). Relative paths aren't allowed.";
    if (app.split(/[\\/]/).some((s) => s === ".." || s === ".")) return "The application path must not contain . or .. folders.";
    const base = app.split(/[\\/]/).pop() ?? "";
    if (base === "" || /[. ]$/.test(base)) return "The application path must end with a program file name.";
    if (FORBIDDEN_EXTENSIONS.test(base)) return "Only .exe programs can be started, not scripts, shortcuts or installers.";
    if (/\.[A-Za-z0-9]{1,5}$/.test(base) && !/\.exe$/i.test(base)) return "Only .exe programs can be started.";
    if (DEVICE_NAMES.test(programName(base))) return "That is a device name, not a program.";
    if (isDeniedProgram(base)) return `${programName(base)}.exe can't be started by a test: command shells, script hosts and similar programs are never allowed.`;
    return undefined;
}

/** Why one argument is not acceptable, or undefined. */
export function argProblem(arg: string): string | undefined {
    if (typeof arg !== "string") return "Arguments must be text.";
    if (arg.length > 200) return "An argument is longer than 200 characters.";
    if (ARG_BAD.test(arg)) return "Arguments can't contain quotes, backticks, $, %, ^, &, |, ;, < or > (they are passed as plain text, never through a shell).";
    if (/(^|[\\/=])\.\.([\\/]|$)/.test(arg)) return "Arguments can't contain .. folders.";
    if (/(^|=)(?:\\\\|\/\/)[^/\\]/.test(arg) && !/^\/\w/.test(arg)) return "Arguments can't point at network shares (\\\\server\\share).";
    if (/(^|=)[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(arg)) return "Arguments can't contain web addresses or other URLs.";
    return undefined;
}

export const DesktopTargetSchema = z
    .object({
        /** A program name (`calc.exe`) or an absolute path. Whether this computer may start it is decided by its allow-list. */
        app: z.string(),
        /** Only used to recognise the application's main window after it starts: a part of its title. */
        windowTitle: z.string().max(120).optional(),
        /** Command-line arguments, one string each (plain data). */
        args: z.array(z.string()).max(DESKTOP_MAX_ARGS).optional(),
        /** How long to wait for the application's window to appear. */
        startTimeoutMs: z.number().int().min(1000).max(DESKTOP_STARTUP_MAX_MS).optional(),
    })
    .strict()
    .superRefine((t, ctx) => {
        const a = appProblem(t.app);
        if (a) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["app"], message: a });
        if (t.windowTitle !== undefined && CONTROL.test(t.windowTitle)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["windowTitle"], message: "The window title has control characters." });
        (t.args ?? []).forEach((arg, i) => {
            const p = argProblem(arg);
            if (p) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["args", i], message: p });
        });
    });

export type DesktopTarget = z.infer<typeof DesktopTargetSchema>;

/** The start-up wait with its default applied. */
export const startTimeoutOf = (t: Pick<DesktopTarget, "startTimeoutMs">): number => t.startTimeoutMs ?? DESKTOP_STARTUP_DEFAULT_MS;

// ── the locator vocabulary ──────────────────────────────────────────────────

/** UI Automation control types a locator may name (`role`). The helper maps each to the real ControlType; nothing else is ever evaluated. */
export const DESKTOP_CONTROL_TYPES = [
    "Button", "Calendar", "CheckBox", "ComboBox", "DataGrid", "DataItem", "Document", "Edit", "Group", "Header", "HeaderItem", "Hyperlink", "Image", "List", "ListItem",
    "Menu", "MenuBar", "MenuItem", "Pane", "ProgressBar", "RadioButton", "ScrollBar", "Slider", "Spinner", "SplitButton", "StatusBar", "Tab", "TabItem", "Table", "Text",
    "Thumb", "TitleBar", "ToolBar", "ToolTip", "Tree", "TreeItem", "Window",
] as const;

/** The control type a locator's role names (case-insensitive), or undefined. */
export function controlTypeOf(role: string | undefined): string | undefined {
    if (!role) return undefined;
    return DESKTOP_CONTROL_TYPES.find((c) => c.toLowerCase() === role.toLowerCase());
}

/** The pseudo address a project that only tests Windows applications carries (like `android-app://` for an Android app). Not a web address: nothing is ever fetched from it. */
export const DESKTOP_APP_URL = "windows-app://desktop";

/** True for the pseudo addresses of device and desktop projects (`android-app://...`, `windows-app://...`): they are never checked as web addresses. */
export const isAppUri = (url: string): boolean => url.startsWith("android-app://") || url.startsWith("windows-app://") || url.startsWith("ios-app://");
