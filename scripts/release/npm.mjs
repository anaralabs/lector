// semantic-release plugin: @semantic-release/npm, loaded from semantic-release's own
// dependencies. Shareable configs resolve plugin names from this folder, where pnpm
// does not link @semantic-release/npm; an absolute path to this file always resolves.
import { plugin } from "./paths.mjs";

const npm = () => plugin("@semantic-release/npm");

export const verifyConditions = async (options, context) => (await npm()).verifyConditions(options, context);
export const prepare = async (options, context) => (await npm()).prepare(options, context);
export const publish = async (options, context) => (await npm()).publish(options, context);
export const addChannel = async (options, context) => (await npm()).addChannel(options, context);
