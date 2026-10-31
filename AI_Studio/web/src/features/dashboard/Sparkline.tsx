import { sparkSegments } from "./dashboard";

const W = 96;
const H = 30;

/** Pass rate of the latest runs as a plain SVG line. The last point is marked; the text label carries the numbers. */
export function Sparkline({ points, label }: { points: Array<{ passRate: number | null }>; label: string }) {
    const segments = sparkSegments(points, W, H);
    const last = segments.at(-1)?.at(-1);
    return (
        <svg className="spark" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={label}>
            <line className="base" x1={0} x2={W} y1={3} y2={3} />
            {segments.map((s, i) => (s.length > 1 ? <polyline key={i} className="line" points={s.map((p) => p.join(",")).join(" ")} /> : null))}
            {last && <circle className="end" cx={last[0]} cy={last[1]} r={3} />}
        </svg>
    );
}
