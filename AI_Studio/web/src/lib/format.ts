/** "2 min ago", "yesterday", "Oct 5" — short, human time. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
    if (!iso) return "—";
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return "—";
    const s = Math.round((now - t) / 1000);
    if (s < 45) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
    const d = Math.round(h / 24);
    if (d === 1) return "yesterday";
    if (d < 7) return `${d} days ago`;
    return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: d > 300 ? "numeric" : undefined });
}

export function duration(ms: number | null | undefined): string {
    if (ms === null || ms === undefined) return "—";
    if (ms < 1000) return `${ms} ms`;
    // Round before choosing the unit, so 9.96 s is "10 s" and 59.6 s is "1 min 0 s".
    const tenths = Math.round(ms / 100) / 10;
    if (tenths < 10) return `${tenths.toFixed(1)} s`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    return `${Math.floor(s / 60)} min ${s % 60} s`;
}

const UNITS = ["bytes", "KB", "MB", "GB", "TB"];
/** "812 KB", "1.8 GB": the same wording the server uses. */
export function formatBytes(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return "0 bytes";
    let v = n;
    let u = 0;
    while (v >= 1024 && u < UNITS.length - 1) {
        v /= 1024;
        u++;
    }
    if (u === 0) return `${Math.round(v)} ${v === 1 ? "byte" : "bytes"}`;
    return `${u >= 2 && v < 100 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)} ${UNITS[u]}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Host part of a URL for compact display. */
export function hostOf(url: string | null | undefined): string {
    if (!url) return "";
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

export function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), { href: url, download: filename }).click();
    URL.revokeObjectURL(url);
}

export function toBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
    });
}
