import { ListChecks } from "lucide-react";
import { Button } from "../../components/ui";
import { go } from "../../lib/router";
import { Modal } from "../../components/Modal";
import { agentInputsHref, type MissingInput } from "./AgentInputs";

/**
 * Before exploring: the inputs the project's chosen testing agents cannot work without and that are not saved yet, each with the agent
 * that needs it, and the way to the Requirements tab where they are kept. The server refuses the exploration with the same words.
 */
export function MissingInputsDialog({ projectId, missing, onClose }: { projectId: string; missing: readonly MissingInput[]; onClose: () => void }) {
    return (
        <Modal
            title="Add what the agents need first"
            titleId="missing-inputs-title"
            onClose={onClose}
            foot={
                <>
                    <Button variant="ghost" onClick={onClose}>
                        Not now
                    </Button>
                    <Button variant="primary" icon={ListChecks} data-autofocus onClick={() => go(agentInputsHref(projectId))}>
                        Open Requirements
                    </Button>
                </>
            }
        >
            <p className="t-secondary">This project’s testing agents cannot explore without these. Add them on the project’s Requirements tab, then explore again.</p>
            <ul className="stack-sm" data-testid="missing-inputs" style={{ paddingLeft: 20, margin: 0 }}>
                {missing.map((m) => (
                    <li key={`${m.agent}-${m.input}`}>
                        <strong>{m.inputName}</strong>: {m.text}
                    </li>
                ))}
            </ul>
        </Modal>
    );
}
