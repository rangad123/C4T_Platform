import { Workbench } from "../features/workbench/Workbench";
import type { Tab } from "../features/workbench/test-model";

/** A test's page is its workbench (Steps, Text, Code, History, with the results always in view): see features/workbench. */
export function TestDetail({ id, tab = "steps" }: { id: string; tab?: Tab }) {
    return <Workbench id={id} tab={tab} />;
}
