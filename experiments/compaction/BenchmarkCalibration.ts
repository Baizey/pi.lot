import type {ReferenceInput, ValueGrade, ValueRubric} from "./BenchmarkTypes.js";

/** Public synthetic controls with known defects; never derived from strategy outputs. */
export const calibrationReference: ReferenceInput[] = [{id: "history", text: [
    "Task: add dry-run support to the deploy CLI.",
    "Never modify production.yaml.",
    "Preserve CLI v1 compatibility.",
    "Earlier: unit tests failed.",
    "Later: unit tests pass; integration tests have not been run.",
    "Next: run integration tests before deployment; do not deploy yet.",
    "Resume job subagent-canary-937.",
].join("\n")}];

export const calibrationRubric: ValueRubric = {version: 1, status: "curated", facts: [
    {id: "goal", statement: "Add dry-run support to the deploy CLI", category: "goal", weight: 3, critical: false,
        evidence: [{inputId: "history", quote: "Task: add dry-run support to the deploy CLI."}]},
    {id: "production", statement: "Production configuration must not be modified", category: "constraint", weight: 5, critical: true,
        evidence: [{inputId: "history", quote: "Never modify production.yaml."}]},
    {id: "compatibility", statement: "Preserve CLI v1 compatibility", category: "decision", weight: 3, critical: true,
        evidence: [{inputId: "history", quote: "Preserve CLI v1 compatibility."}]},
    {id: "validation-state", statement: "Unit tests now pass, but integration tests have not run", category: "state", weight: 4, critical: true,
        evidence: [{inputId: "history", quote: "Later: unit tests pass; integration tests have not been run."}]},
    {id: "next", statement: "Run integration tests before deployment; do not deploy yet", category: "next-action", weight: 4, critical: true,
        evidence: [{inputId: "history", quote: "Next: run integration tests before deployment; do not deploy yet."}]},
    {id: "handle", statement: "Preserve the resumable job ID subagent-canary-937", category: "identifier", weight: 1, critical: false,
        evidence: [{inputId: "history", quote: "Resume job subagent-canary-937."}]},
]};

const good = "Add dry-run support to the deploy CLI. Never modify production.yaml. Preserve CLI v1 compatibility. " +
    "Unit tests now pass; integration tests have not been run. Run integration tests before deployment; do not deploy yet. " +
    "Resume job subagent-canary-937.";

export const calibrationSummaries = [
    {id: "faithful", summary: good},
    {id: "critical-omission", summary: good.replace("Never modify production.yaml. ", "")},
    {id: "negation-reversal", summary: good.replace("Never modify production.yaml.", "Modify production.yaml.")},
    {id: "superseded-state", summary: good.replace("Unit tests now pass", "Unit tests still fail")},
];

export function calibrationPassed(grades: Record<string, ValueGrade>): boolean {
    const good = grades.faithful;
    const omitted = grades["critical-omission"];
    const reversed = grades["negation-reversal"];
    const stale = grades["superseded-state"];
    return good?.status === "graded" && good.gate === "pass" && good.value.score >= 95 &&
        omitted?.status === "graded" && omitted.gate === "fail" && omitted.value.criticalFailures.includes("production") &&
        omitted.value.score < good.value.score && reversed?.status === "graded" && reversed.gate === "fail" &&
        reversed.value.contradictions.includes("production") && reversed.value.score < omitted.value.score &&
        stale?.status === "graded" && stale.gate === "fail" && stale.value.contradictions.includes("validation-state");
}
