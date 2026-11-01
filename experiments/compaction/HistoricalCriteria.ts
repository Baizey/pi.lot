import {readFile} from "node:fs/promises";
import type {PreparedBenchmarkCase} from "./BenchmarkTypes.js";
import {fingerprint} from "./CompactionEvaluation.js";
import {validateRubric} from "./ValueRetention.js";

type HistoricalQuestion = {id: string; question: string; factIds: string[]};

/** Source anchoring checks schema and contiguous evidence, not semantic entailment or human curation. */
export async function loadHistoricalCriteria(file: string, cases: PreparedBenchmarkCase[]): Promise<{
    hash: string; cases: PreparedBenchmarkCase[]; questions: Record<string, HistoricalQuestion[]>;
}> {
    const raw = await readFile(file, "utf8");
    const value = object(JSON.parse(raw), ["version", "cases"]);
    if (value.version !== 1 || !Array.isArray(value.cases) || !cases.length || value.cases.length !== cases.length) throw new Error("Invalid historical criteria version or case coverage");
    const selected = new Map(cases.map((item) => [item.definition.id, item]));
    if (selected.size !== cases.length) throw new Error("Duplicate selected historical case ID");
    const loaded = new Map<string, {prepared: PreparedBenchmarkCase; questions: HistoricalQuestion[]}>();
    for (const entry of value.cases) {
        const item = object(entry, ["caseId", "referenceHash", "rubric", "questions"]);
        if (typeof item.caseId !== "string" || !selected.has(item.caseId) || loaded.has(item.caseId)) throw new Error("Unknown or duplicate historical criteria case ID");
        const prepared = selected.get(item.caseId)!;
        if (typeof item.referenceHash !== "string" || item.referenceHash !== prepared.definition.referenceHash) throw new Error("Historical criteria reference hash mismatch");
        const rubric = validateRubric(item.rubric, prepared.reference);
        if (rubric.status !== "draft") throw new Error("Historical criteria must remain draft; model criteria cannot self-certify curated");
        if (!Array.isArray(item.questions) || !item.questions.length) throw new Error("Historical criteria require continuation questions");
        const factIds = new Set(rubric.facts.map((fact) => fact.id));
        const seenQuestions = new Set<string>();
        const covered = new Set<string>();
        const questions: HistoricalQuestion[] = item.questions.map((entry: unknown) => {
            const question = object(entry, ["id", "question", "factIds"]);
            if (typeof question.id !== "string" || !question.id.trim() || seenQuestions.has(question.id) ||
                typeof question.question !== "string" || !question.question.trim() || !Array.isArray(question.factIds) || !question.factIds.length) throw new Error("Invalid historical continuation question");
            seenQuestions.add(question.id);
            const seenFacts = new Set<string>();
            const ids: string[] = question.factIds.map((id: unknown) => {
                if (typeof id !== "string" || !factIds.has(id) || seenFacts.has(id)) throw new Error("Unknown or duplicate question fact ID");
                seenFacts.add(id);
                covered.add(id);
                return id;
            });
            return {id: question.id, question: question.question, factIds: ids};
        });
        if (rubric.facts.some((fact) => fact.critical && !covered.has(fact.id))) throw new Error("Historical questions do not cover every critical fact");
        loaded.set(item.caseId, {prepared: {...prepared, definition: {...prepared.definition, rubric}}, questions});
    }
    return {hash: fingerprint(raw), cases: cases.map((item) => loaded.get(item.definition.id)!.prepared),
        questions: Object.fromEntries([...loaded].map(([id, item]) => [id, item.questions]))};
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new Error("Invalid historical criteria object shape");
    return value as Record<string, unknown>;
}
