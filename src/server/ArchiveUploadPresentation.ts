import {stripVTControlCharacters} from "node:util";
import type {ArchiveUploadReport} from "./SessionArchive.js";

export function archiveUploadNotification(
    report: ArchiveUploadReport, scope: "current" | "all", apiKey: string, automatic = false,
): {message: string; type: "info" | "warning"} {
    const summary = `${automatic ? "Automatic archive" : "Archive"} upload (${scope}): ${report.uploaded} uploaded, ${report.unchanged} unchanged, ${report.failed} failed.`;
    const warnings = report.warnings.slice(0, 20).map((warning) => `Warning: ${safeArchiveText(warning, apiKey)}`);
    const failures = report.failures.slice(0, 20).map(({file, message}) => (
        `Failed: ${safeArchiveText(file, apiKey, 512)}: ${safeArchiveText(message, apiKey)}`
    ));
    return {
        message: [summary, ...warnings, ...failures].join("\n"),
        type: report.failed > 0 || report.warnings.length > 0 ? "warning" : "info",
    };
}

function safeArchiveText(value: string, apiKey: string, limit = 1024): string {
    const sanitized = stripVTControlCharacters(value)
        .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
        .split(apiKey).join("[redacted]");
    return sanitized.length > limit ? `${sanitized.slice(0, limit - 1)}…` : sanitized;
}
