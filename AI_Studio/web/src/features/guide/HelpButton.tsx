import { CircleHelp } from "lucide-react";
import { Button } from "../../components/ui";
import { useHelp } from "./HelpContext";

/** The small Help button in the top bar of every page. */
export function HelpButton() {
    const help = useHelp();
    return (
        <Button variant="ghost" size="sm" icon={CircleHelp} className="help-btn" data-help-button data-tour="help" aria-expanded={help.open} aria-controls={help.open ? "help-panel" : undefined} onClick={help.toggle}>
            Help
        </Button>
    );
}

/** The Help entry of the sidebar, below Settings. */
export function HelpNavItem() {
    const help = useHelp();
    return (
        <button type="button" className="nav-item help-nav" data-help-button data-tour="nav-help" aria-expanded={help.open} aria-controls={help.open ? "help-panel" : undefined} onClick={help.toggle}>
            <CircleHelp size={18} aria-hidden />
            Help
        </button>
    );
}
