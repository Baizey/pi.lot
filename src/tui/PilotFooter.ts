import {stripVTControlCharacters} from "node:util";
import type {
    ExtensionContext,
    ReadonlyFooterDataProvider,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {Component} from "@earendil-works/pi-tui";
import {ThemeColor} from "./Color.js";
import {formatThinkingIndicator} from "./ThinkingIndicator.js";
import {
    displayWidth,
    sanitizeTerminalLine,
    truncateToWidth,
} from "./terminalText.js";

const THINKING_STATUS_KEY = "pi.lot-thinking";
const SUBAGENT_STATUS_KEY = "pi.lot-subagents";
const OWNED_STATUS_KEYS = new Set([THINKING_STATUS_KEY, SUBAGENT_STATUS_KEY]);
const FIELD_SEPARATOR = " · ";
const MIN_GROUP_GAP = 2;

type AccountedUsage = NonNullable<Extract<SessionEntry, {type: "compaction"}>["usage"]>;

type UsageTotals = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    latestCacheHitRate: number | undefined;
};

type RowCandidate = {
    left: string;
    right: string;
};

/** Renders Pi.lot's structured, live session footer. */
export class PilotFooter implements Component {
    private disposedValue = false;

    constructor(
        private readonly ctx: ExtensionContext,
        private readonly footerData: ReadonlyFooterDataProvider,
        private readonly getAutoCompactionEnabled: () => boolean | undefined,
    ) {}

    get disposed(): boolean {
        return this.disposedValue;
    }

    render(width: number): string[] {
        const columns = renderWidth(width);
        const statuses = this.footerData.getExtensionStatuses();
        const lines = [
            this.renderModelRow(columns),
            this.renderUsageRow(columns, statuses.get(SUBAGENT_STATUS_KEY)),
        ];
        const extraStatuses = this.renderExtraStatuses(columns, statuses);
        if (extraStatuses !== undefined) lines.push(extraStatuses);
        return lines.map((line) => truncateToWidth(line, columns));
    }

    invalidate(): void {
        // All footer data and the active theme are read again by render().
    }

    dispose(): void {
        this.disposedValue = true;
    }

    private renderModelRow(width: number): string {
        const theme = this.ctx.ui.theme;
        const model = this.ctx.model;
        const modelName = sanitizeUntrusted(model?.id ?? "no-model") || "no-model";
        const provider = sanitizeUntrusted(model?.provider ?? "");
        const withProvider = provider ? `${provider}/${modelName}` : modelName;
        // Shared statuses can be overwritten by another loaded pi.lot copy. Render
        // our own fixed-width indicator from live state, never from that shared text.
        const thinkingStatus = formatThinkingIndicator(this.ctx);
        const compactThinkingStatus = formatThinkingIndicator(this.ctx, false);
        return renderResponsiveRow(width, [
            {left: theme.fg("dim", withProvider), right: thinkingStatus},
            {left: theme.fg("dim", modelName), right: thinkingStatus},
            {left: theme.fg("dim", withProvider), right: compactThinkingStatus},
            {left: theme.fg("dim", modelName), right: compactThinkingStatus},
        ]);
    }

    private renderUsageRow(width: number, rawSubagentStatus: string | undefined): string {
        const theme = this.ctx.ui.theme;
        const totals = collectUsage(this.ctx.sessionManager.getEntries());
        const contextUsage = this.ctx.getContextUsage();
        const contextWindow = contextUsage?.contextWindow ?? this.ctx.model?.contextWindow ?? 0;
        const contextPercentValue = contextUsage?.percent ?? 0;
        const contextPercent = contextUsage?.percent === null
            ? "?"
            : contextPercentValue.toFixed(1);
        const auto = this.getAutoCompactionEnabled() === true ? " (auto)" : "";
        const percentLabel = contextPercent === "?" ? "?" : `${contextPercent}%`;
        const compactContextValue = `${percentLabel} / ${formatTokens(contextWindow)}`;
        const contextValue = compactContextValue + auto;
        const contextColor = contextUsageColor(contextUsage?.percent ?? null);
        const contextField = theme.fg("dim", "Context ") + theme.fg(contextColor, contextValue);
        const tokenFields = this.formatTokenFields(totals, true);
        const tokenFieldsWithoutCache = this.formatTokenFields(totals, false);
        const costField = this.formatCostField(totals.cost);
        const fullFields = [contextField, ...tokenFields, costField].filter(Boolean);
        const compactFields = [contextField, ...tokenFieldsWithoutCache, costField].filter(Boolean);
        const noCostFields = [contextField, ...tokenFieldsWithoutCache].filter(Boolean);
        const contextAndCost = [contextField, costField].filter(Boolean);
        const leftVariants = unique([
            joinFields(fullFields, theme),
            joinFields(compactFields, theme),
            joinFields(noCostFields, theme),
            joinFields(contextAndCost, theme),
            contextField,
            theme.fg(contextColor, compactContextValue),
            theme.fg(contextColor, percentLabel),
        ]);
        const subagentStatus = sanitizeStatus(rawSubagentStatus);
        const sessionName = sanitizeUntrusted(this.ctx.sessionManager.getSessionName() ?? "");
        // Bound long names so the context value and agent counts keep their space.
        const sessionNameWidth = Math.min(
            Math.floor(width / 3),
            width - displayWidth(compactContextValue) - MIN_GROUP_GAP
                - (subagentStatus ? displayWidth(subagentStatus) + displayWidth(FIELD_SEPARATOR) : 0),
        );
        const sessionField = sessionName && sessionNameWidth > 1
            ? theme.fg("dim", truncateToWidth(sessionName, sessionNameWidth))
            : "";
        const right = joinFields([subagentStatus, sessionField].filter(Boolean), theme);

        return renderResponsiveRow(
            width,
            leftVariants.map((left) => ({left, right})),
        );
    }

    private renderExtraStatuses(
        width: number,
        statuses: ReadonlyMap<string, string>,
    ): string | undefined {
        const theme = this.ctx.ui.theme;
        const values = [...statuses.entries()]
            .filter(([key]) => !OWNED_STATUS_KEYS.has(key))
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([, value]) => sanitizeStatus(value))
            .filter(Boolean);
        if (values.length === 0) return undefined;
        return truncateToWidth(values.join(theme.fg("dim", FIELD_SEPARATOR)), width);
    }

    private formatTokenFields(totals: UsageTotals, includeCache: boolean): string[] {
        const theme = this.ctx.ui.theme;
        const tokens: string[] = [];
        const cache: string[] = [];
        if (totals.input) tokens.push(`↑${formatTokens(totals.input)}`);
        if (totals.output) tokens.push(`↓${formatTokens(totals.output)}`);
        if (includeCache) {
            if (totals.cacheRead) cache.push(`R${formatTokens(totals.cacheRead)}`);
            if (totals.cacheWrite) cache.push(`W${formatTokens(totals.cacheWrite)}`);
            if ((totals.cacheRead || totals.cacheWrite) && totals.latestCacheHitRate !== undefined) {
                cache.push(`CH${totals.latestCacheHitRate.toFixed(1)}%`);
            }
        }
        return [tokens, cache].filter((group) => group.length > 0)
            .map((group) => theme.fg("dim", group.join(" ")));
    }

    private formatCostField(cost: number): string {
        const model = this.ctx.model;
        const subscription = model !== undefined && (
            model.provider === "kimi-coding"
            || (
                this.ctx.modelRegistry.isUsingOAuth(model)
                && this.ctx.modelRegistry.getProvider(model.provider)?.auth.oauth?.isSubscription === true
            )
        );
        if (!cost && !subscription) return "";
        return this.ctx.ui.theme.fg("dim", `$${cost.toFixed(3)}${subscription ? " (sub)" : ""}`);
    }
}

function contextUsageColor(percent: number | null): ThemeColor {
    if (percent === null) return ThemeColor.thinkingOff;
    // Context can exceed the model's window; the final band has no upper bound.
    if (percent >= 90) return ThemeColor.thinkingMax;
    if (percent >= 80) return ThemeColor.thinkingXhigh;
    if (percent >= 60) return ThemeColor.thinkingHigh;
    if (percent >= 40) return ThemeColor.thinkingMedium;
    if (percent >= 20) return ThemeColor.thinkingLow;
    return ThemeColor.thinkingMinimal;
}

function collectUsage(entries: readonly SessionEntry[]): UsageTotals {
    const totals: UsageTotals = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        latestCacheHitRate: undefined,
    };
    for (const entry of entries) {
        if (entry.type === "message" && entry.message.role === "assistant") {
            addUsage(totals, entry.message.usage);
            const promptTokens = entry.message.usage.input
                + entry.message.usage.cacheRead
                + entry.message.usage.cacheWrite;
            totals.latestCacheHitRate = promptTokens > 0
                ? entry.message.usage.cacheRead / promptTokens * 100
                : undefined;
        } else if (
            entry.type === "message"
            && entry.message.role === "toolResult"
            && entry.message.usage
        ) {
            addUsage(totals, entry.message.usage);
        } else if (
            (entry.type === "compaction" || entry.type === "branch_summary")
            && entry.usage
        ) {
            addUsage(totals, entry.usage);
        }
    }
    return totals;
}

function addUsage(totals: UsageTotals, usage: AccountedUsage): void {
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.cost += usage.cost.total;
}

function renderResponsiveRow(width: number, candidates: readonly RowCandidate[]): string {
    if (width <= 0 || candidates.length === 0) return "";
    for (const candidate of candidates) {
        const rendered = alignCompleteGroups(candidate.left, candidate.right, width);
        if (rendered !== undefined) return rendered;
    }

    const {left, right} = candidates.at(-1)!;
    if (!right) return truncateToWidth(left, width);
    const rightWidth = displayWidth(right);
    const availableForLeft = width - rightWidth - MIN_GROUP_GAP;
    if (rightWidth <= width && availableForLeft > 0) {
        const boundedLeft = truncateToWidth(left, availableForLeft);
        if (boundedLeft) {
            return alignCompleteGroups(boundedLeft, right, width)
                ?? truncateToWidth(boundedLeft, width);
        }
    }
    if (displayWidth(left) <= width) return left;
    if (rightWidth <= width) return " ".repeat(width - rightWidth) + right;
    return truncateToWidth(left, width);
}

function alignCompleteGroups(left: string, right: string, width: number): string | undefined {
    const leftWidth = displayWidth(left);
    const rightWidth = displayWidth(right);
    if (!right) return leftWidth <= width ? left : undefined;
    if (!left) return rightWidth <= width ? " ".repeat(width - rightWidth) + right : undefined;
    if (leftWidth + MIN_GROUP_GAP + rightWidth > width) return undefined;
    return left + " ".repeat(width - leftWidth - rightWidth) + right;
}

function joinFields(fields: readonly string[], theme: ExtensionContext["ui"]["theme"]): string {
    return fields.join(theme.fg("dim", FIELD_SEPARATOR));
}

function sanitizeUntrusted(value: string): string {
    return sanitizeTerminalLine(stripVTControlCharacters(value)).trim();
}

function sanitizeStatus(value: string | undefined): string {
    return value ? sanitizeTerminalLine(value).replace(/\s+/g, " ").trim() : "";
}

function formatTokens(count: number): string {
    if (count < 1_000) return count.toString();
    if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
    if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
    if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    return `${Math.round(count / 1_000_000)}M`;
}

function unique(values: readonly string[]): string[] {
    return [...new Set(values)];
}

function renderWidth(width: number): number {
    if (!Number.isFinite(width) || width <= 0) return 0;
    return Math.floor(width);
}
