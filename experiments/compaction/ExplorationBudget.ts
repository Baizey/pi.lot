import {readFile} from "node:fs/promises";
import path from "node:path";
import type {BudgetSnapshot} from "./BudgetedModel.js";
import {fingerprint} from "./CompactionEvaluation.js";

const unknownReason = "Provider usage is unknown; future calls are blocked";
const declaration = "Explicitly authorized development restart: retain unknown usage as a reservation, not known or settled billing.";
const budgetExtensionDeclaration = "Explicitly authorized development restart: extend cumulative SDK call/catalogue-estimate limits while retaining all prior accounting; catalogue estimates are not invoiced charges.";
const tolerance = 1e-10;
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ExplorationLimits = {maxCalls: number; maxCostUsd: number};
export type ExplorationBudgetExtension = {
    declaration: typeof budgetExtensionDeclaration; source: string; sourceHash: string;
    from: ExplorationLimits; to: ExplorationLimits;
};

export function explorationBudgetExtension(source: string, sourceHash: string, from: ExplorationLimits, to: ExplorationLimits): ExplorationBudgetExtension {
    validateLimits(from);
    validateLimits(to);
    if (to.maxCalls <= from.maxCalls || to.maxCostUsd < from.maxCostUsd ||
        !/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error("Budget extension requires a higher call cap and a nondecreasing catalogue-estimate guard");
    return {declaration: budgetExtensionDeclaration, source: path.resolve(source), sourceHash,
        from: {maxCalls: from.maxCalls, maxCostUsd: from.maxCostUsd}, to: {maxCalls: to.maxCalls, maxCostUsd: to.maxCostUsd}};
}
export type UnknownReservation = {
    source: string; sourceHash: string; sourceHashes: Record<string, string>;
    declaration: typeof declaration; calls: number; reservedUsd: number;
};
export type ExplorationTotals = {
    calls: number; spentUsd: number; unknownCalls: number; reservedUnknownUsd: number;
    reservations: UnknownReservation[];
};
export const emptyExplorationTotals = (): ExplorationTotals => ({calls: 0, spentUsd: 0, unknownCalls: 0, reservedUnknownUsd: 0, reservations: []});

/** Current unknown usage stays distinct from inherited, explicitly authorized reservations. */
export function cumulativeExplorationBudget(carry: ExplorationTotals, ledger: BudgetSnapshot): ExplorationTotals {
    return {calls: carry.calls + ledger.calls.length, spentUsd: carry.spentUsd + ledger.spentUsd,
        unknownCalls: carry.unknownCalls + ledger.calls.filter((call) => call.status === "unknown").length,
        reservedUnknownUsd: carry.reservedUnknownUsd + ledger.reservedUsd, reservations: carry.reservations};
}

export function remainingExplorationBudget(carry: ExplorationTotals, limits: ExplorationLimits): ExplorationLimits {
    validateLimits(limits);
    const remaining = {maxCalls: limits.maxCalls - carry.calls,
        maxCostUsd: limits.maxCostUsd - carry.spentUsd - carry.reservedUnknownUsd};
    if (remaining.maxCalls <= 0 || remaining.maxCostUsd <= 0) throw new Error("Exploration budget exhausted");
    return remaining;
}

/** Validate one receipt. The caller supplies independently checked inherited accounting. */
export function explorationCarry(value: unknown, limits: ExplorationLimits, inherited = emptyExplorationTotals(),
    restart?: {source: string; sourceHash: string}): ExplorationTotals {
    validateLimits(limits);
    const previous = record(value);
    const budget = record(previous.budget);
    const recordedThinking = record(previous.options).thinking;
    const thinking = recordedThinking === undefined ? "low" : recordedThinking;
    if (typeof thinking !== "string" || !thinkingLevels.has(thinking) ||
        (previous.thinking !== undefined && previous.thinking !== thinking) ||
        (previous.report !== undefined && record(previous.report).thinking !== undefined && record(previous.report).thinking !== thinking)) {
        throw new Error("Invalid or inconsistent stage thinking level");
    }
    const carry = totals(previous.carry);
    if (fingerprint(carry) !== fingerprint(inherited)) throw new Error("Inherited accounting does not match its source ledger");
    const local = remainingExplorationBudget(carry, limits);
    const localLimits = record(budget.limits);
    if (localLimits.maxCalls !== local.maxCalls || !equalCost(localLimits.maxCostUsd, local.maxCostUsd) ||
        localLimits.maxOutputTokens !== 4096 || localLimits.thinkingLevel !== thinking) throw new Error("Stage limits do not subtract all inherited usage");
    if (!Array.isArray(budget.calls)) throw new Error("Missing call ledger");
    let settled = 0;
    let unknown = 0;
    for (const entry of budget.calls) {
        const call = record(entry);
        nonnegative(call.durationMs);
        if (call.status === "settled") {
            nonnegative(call.costUsd);
            settled += call.costUsd;
            const components = [call.inputCostUsd, call.outputCostUsd, call.cacheReadCostUsd, call.cacheWriteCostUsd];
            if (components.some((cost) => cost !== undefined)) {
                for (const cost of components) nonnegative(cost);
                if (!equalCost(components.reduce<number>((sum, cost) => sum + Number(cost), 0), call.costUsd)) throw new Error("Inconsistent settled cost components");
            }
        } else if (call.status === "unknown") {
            unknown++;
            // Partial provider usage is not evidence that any of this call was settled.
            for (const cost of [call.costUsd, call.inputCostUsd, call.outputCostUsd, call.cacheReadCostUsd, call.cacheWriteCostUsd]) {
                if (cost !== undefined) nonnegative(cost);
            }
        } else throw new Error("Nonterminal or invalid call reservation");
    }
    nonnegative(budget.spentUsd);
    nonnegative(budget.reservedUsd);
    if (!equalCost(settled, budget.spentUsd) || (unknown > 0) !== (budget.reservedUsd > 0) ||
        budget.calls.length > local.maxCalls || budget.spentUsd + budget.reservedUsd > local.maxCostUsd + tolerance) throw new Error("Inconsistent current budget totals");
    if (unknown ? !restart || budget.blockedReason !== unknownReason : Boolean(budget.blockedReason)) throw new Error("Previous SDK usage is not fully settled or explicitly reserved");
    const expected: ExplorationTotals = {calls: carry.calls + budget.calls.length, spentUsd: carry.spentUsd + budget.spentUsd,
        unknownCalls: carry.unknownCalls + unknown, reservedUnknownUsd: carry.reservedUnknownUsd + budget.reservedUsd, reservations: carry.reservations};
    // Original receipts predate explicit unknown totals. Only that legacy shape may omit them.
    const cumulative = totals(previous.cumulative, unknown > 0 ? {unknownCalls: unknown, reservedUnknownUsd: budget.reservedUsd} : undefined);
    if (cumulative.calls !== expected.calls || !equalCost(cumulative.spentUsd, expected.spentUsd) ||
        cumulative.unknownCalls !== expected.unknownCalls || !equalCost(cumulative.reservedUnknownUsd, expected.reservedUnknownUsd) ||
        fingerprint(cumulative.reservations) !== fingerprint(expected.reservations)) throw new Error("Inconsistent cumulative accounting");
    // A receipt may exhaust its own call cap and still be valid history for an explicitly extended restart.
    // The outer reader checks that the requested destination still has spendable budget.
    if (unknown && restart) {
        const hashes = record(previous.hashes);
        const sourceHashes: Record<string, string> = {};
        if (!Object.keys(hashes).length) throw new Error("Missing restart source provenance");
        for (const [file, hash] of Object.entries(hashes)) {
            if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid source hash");
            sourceHashes[file] = hash;
        }
        expected.reservations = [...expected.reservations, {source: restart.source, sourceHash: restart.sourceHash,
            sourceHashes, declaration, calls: unknown, reservedUsd: budget.reservedUsd}];
    }
    return expected;
}

/** Walk the actual receipt chain, verifying hashes and every inherited subtotal before authorizing a new stage. */
export async function readExplorationBudget(file: string, limits: ExplorationLimits, reserveUnknownUsage = false, extendBudget = false): Promise<ExplorationTotals> {
    validateLimits(limits);
    if (extendBudget && !reserveUnknownUsage) throw new Error("Budget extension requires an explicit development restart");
    const visiting = new Set<string>();
    const visit = async (source: string, restart: boolean, destination: ExplorationLimits, extend: boolean): Promise<{totals: ExplorationTotals; hash: string; limits: ExplorationLimits}> => {
        source = path.resolve(source);
        if (visiting.has(source)) throw new Error("Cyclic exploration ledger provenance");
        visiting.add(source);
        const raw = await readFile(source, "utf8");
        const hash = fingerprint(raw);
        const previous = record(JSON.parse(raw));
        const options = record(previous.options);
        count(options.maxCalls);
        nonnegative(options.maxCostUsd);
        const sourceLimits = {maxCalls: options.maxCalls, maxCostUsd: options.maxCostUsd};
        validateLimits(sourceLimits);
        if (options.live !== true) throw new Error("Non-live exploration source");
        if (extend) explorationBudgetExtension(source, hash, sourceLimits, destination);
        else if (sourceLimits.maxCalls !== destination.maxCalls || sourceLimits.maxCostUsd !== destination.maxCostUsd) throw new Error("Mismatched global exploration limits without explicit extension");
        if (previous.report === undefined) {
            // A calibration transport failure can stop before the benchmark constructs a report.
            // This exception is restart-only and needs explicit cleanup evidence, not inferred absence of work.
            const budget = record(previous.budget);
            const calibration = Object.values(record(previous.calibration)).map(record);
            const unknown = Array.isArray(budget.calls) ? budget.calls.filter((call) => record(call).status === "unknown").length : 0;
            if (!restart || previous.status !== "stopped" || options.phase !== "development" || previous.cleanupComplete !== true ||
                previous.continuationInterrupted || budget.blockedReason !== unknownReason || !unknown ||
                !Array.isArray(budget.calls) || budget.calls.some((call) => record(call).phase !== "judge" || record(call).completion !== true) ||
                calibration.length !== budget.calls.length || calibration.some((grade) => grade.status !== "graded" && grade.status !== "unscored") ||
                calibration.filter((grade) => grade.status === "unscored" && typeof grade.error === "string" && grade.error.length > 0).length < unknown ||
                !Array.isArray(previous.continuations) || previous.continuations.length !== 0) throw new Error("Pre-report stop lacks terminal calibration cleanup/accounting");
        } else {
            const report = record(previous.report);
            if (previous.status !== "complete" || report.mode !== "live" || !Array.isArray(report.trials) ||
                report.trials.some((trial) => record(record(trial).result).cleanupComplete !== true) ||
                previous.cleanupComplete === false || previous.continuationInterrupted ||
                (report.interrupted && (!restart || report.interrupted !== unknownReason))) throw new Error("Previous stage is not terminal with completed cleanup");
        }
        const prior = options.previous;
        const restarted = options.restartFrom;
        if ((prior && typeof prior !== "string") || (restarted && typeof restarted !== "string") || (prior && restarted) ||
            (restarted ? options.phase !== "development" || options.reserveUnknownUsage !== true : options.reserveUnknownUsage === true) ||
            (options.extendBudget !== undefined && typeof options.extendBudget !== "boolean") ||
            (options.extendBudget === true && !restarted)) throw new Error("Invalid prior-stage authorization");
        let inherited = emptyExplorationTotals();
        const parent = prior || restarted;
        if (parent) {
            const receipt = await visit(String(parent), Boolean(restarted), sourceLimits, options.extendBudget === true);
            if (previous.previousHash !== receipt.hash) throw new Error("Prior ledger hash mismatch");
            if (options.extendBudget === true) {
                const authorization = explorationBudgetExtension(String(parent), receipt.hash, receipt.limits, sourceLimits);
                if (fingerprint(previous.budgetExtension) !== fingerprint(authorization)) throw new Error("Budget extension authorization/provenance mismatch");
            } else if (previous.budgetExtension !== undefined) throw new Error("Budget authorization without explicit extension flag");
            inherited = receipt.totals;
        } else if (previous.previousHash || previous.budgetExtension !== undefined || sourceLimits.maxCalls > 128 || sourceLimits.maxCostUsd > .25) throw new Error("Missing prior ledger source or budget authorization");
        const result = explorationCarry(previous, sourceLimits, inherited, restart ? {source, sourceHash: hash} : undefined);
        visiting.delete(source);
        return {totals: result, hash, limits: sourceLimits};
    };
    const result = (await visit(file, reserveUnknownUsage, limits, extendBudget)).totals;
    remainingExplorationBudget(result, limits);
    return result;
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid exploration accounting object");
    return value as Record<string, unknown>;
}

function nonnegative(value: unknown): asserts value is number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid finite nonnegative accounting amount");
}

function count(value: unknown): asserts value is number {
    nonnegative(value);
    if (!Number.isSafeInteger(value)) throw new Error("Invalid accounting call count");
}

function equalCost(left: unknown, right: number): boolean {
    return typeof left === "number" && Number.isFinite(left) && Math.abs(left - right) <= tolerance;
}

function validateLimits(limits: ExplorationLimits): void {
    count(limits.maxCalls);
    nonnegative(limits.maxCostUsd);
    if (limits.maxCalls < 1 || limits.maxCalls > 512 || limits.maxCostUsd <= 0 || limits.maxCostUsd > 10) throw new Error("Invalid global exploration limits");
}

function totals(value: unknown, legacyUnknown?: {unknownCalls: number; reservedUnknownUsd: number}): ExplorationTotals {
    const total = record(value);
    count(total.calls);
    nonnegative(total.spentUsd);
    const legacy = total.unknownCalls === undefined && total.reservedUnknownUsd === undefined && total.reservations === undefined;
    const unknownCalls = legacy ? legacyUnknown?.unknownCalls ?? 0 : total.unknownCalls;
    const reservedUnknownUsd = legacy ? legacyUnknown?.reservedUnknownUsd ?? 0 : total.reservedUnknownUsd;
    count(unknownCalls);
    nonnegative(reservedUnknownUsd);
    if (unknownCalls > total.calls || (unknownCalls > 0) !== (reservedUnknownUsd > 0)) throw new Error("Inconsistent unknown accounting");
    const reservations = legacy ? [] : total.reservations;
    if (!Array.isArray(reservations)) throw new Error("Missing reservation authorization ledger");
    const authorized: UnknownReservation[] = reservations.map((entry) => {
        const reservation = record(entry);
        count(reservation.calls);
        nonnegative(reservation.reservedUsd);
        if (!reservation.calls || !reservation.reservedUsd || reservation.declaration !== declaration ||
            typeof reservation.source !== "string" || !path.isAbsolute(reservation.source) ||
            typeof reservation.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(reservation.sourceHash)) throw new Error("Invalid unknown reservation authorization");
        const sourceHashes: Record<string, string> = {};
        for (const [file, hash] of Object.entries(record(reservation.sourceHashes))) {
            if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid reservation provenance");
            sourceHashes[file] = hash;
        }
        return {source: reservation.source, sourceHash: reservation.sourceHash, sourceHashes, declaration,
            calls: reservation.calls, reservedUsd: reservation.reservedUsd};
    });
    return {calls: total.calls, spentUsd: total.spentUsd, unknownCalls, reservedUnknownUsd, reservations: authorized};
}
