/** Each retained-conversation turn gets a fresh, approval-aware execution budget. */
export const DEFAULT_SUBAGENT_TIMEOUT_SECONDS = 86_400;
export const MAX_SUBAGENT_TIMEOUT_SECONDS = 86_400;

/** Queueing, idle time, and approval waits all consume the fixed conversation lifetime. */
export const SUBAGENT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
