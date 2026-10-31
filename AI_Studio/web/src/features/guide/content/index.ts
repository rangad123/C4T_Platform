import type { GlossaryEntry, Topic, Want } from "../types.js";
import { bigPicture } from "./big-picture.js";
import { checks } from "./checks.js";
import { connect } from "./connect.js";
import { glossaryEntries } from "./glossary.js";
import { making } from "./making.js";
import { oneTest } from "./one-test.js";
import { platform } from "./platform.js";
import { running } from "./running.js";
import { wantList } from "./wants.js";

/**
 * The written content of the in-app guide: topics (one per feature of docs/USER_GUIDE.md, grouped the same way), the glossary and the
 * "I want to..." list. Plain language, the product's own words; `tests/guide-content.test.ts` guards the shapes, ids, on-screen names and style.
 */
export const topics: Topic[] = [...making, ...oneTest, ...running, ...checks, ...bigPicture, ...connect, ...platform];

export const glossary: GlossaryEntry[] = glossaryEntries;

export const wants: Want[] = wantList;
