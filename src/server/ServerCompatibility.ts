import {decodeVersionResponse} from "./ServerResponses.js";

export const SERVER_VERSION_REQUIREMENT = "0.*";

/** Exact pins retain literal equality; trailing wildcards match stable releases. */
export function matchesServerVersion(version: string, requirement: string): boolean {
    if (!decodeVersionResponse({version})) return false;
    if (!requirement.endsWith(".*")) return version === requirement;
    const required = requirement.slice(0, -2).split(".");
    if (required.length !== 1 && required.length !== 2) return false;
    const release = version.split("+", 1)[0];
    if (release.includes("-")) return false;
    const actual = release.split(".");
    return required.every((component, index) => component === actual[index]);
}
