import { TriangleAlert } from "lucide-react";
import { Badge } from "../../components/ui";
import { failsOn, type CompatBrief } from "./variants";

/** "Fails on Safari" next to a test in the list. Nothing when it passed everywhere it ran. */
export function CompatBadge({ compat }: { compat: CompatBrief | null | undefined }) {
    if (!compat?.failing.length) return null;
    return (
        <Badge tone="warning" icon={TriangleAlert} title={compat.severity?.basis ? `Medium severity: ${compat.severity.basis}` : undefined}>
            {failsOn(compat.failing)}
        </Badge>
    );
}
