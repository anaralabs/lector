// semantic-release plugin: @semantic-release/github, commenting on the issues
// and pull requests of the package's own commits only (see paths.mjs).
// Options: the paths.mjs options, plus `github` for the wrapped plugin.
import { onlyPackageCommits, plugin } from "./paths.mjs";

const github = () => plugin("@semantic-release/github");

export const verifyConditions = async (options, context) => (await github()).verifyConditions(options.github ?? {}, context);
export const publish = async (options, context) => (await github()).publish(options.github ?? {}, context);
export const addChannel = async (options, context) => (await github()).addChannel(options.github ?? {}, context);
export const success = async (options, context) => (await github()).success(options.github ?? {}, onlyPackageCommits(options, context));
export const fail = async (options, context) => (await github()).fail(options.github ?? {}, context);
