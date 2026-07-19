// noinspection JSUnusedGlobalSymbols

export enum PolicyStatus {
    ALLOWED = "ALLOWED",
    DENIED = "DENIED",
}

export enum PolicyLifetime {
    ONCE = "ONCE",
    SESSION = "SESSION",
    LOCAL = "LOCAL",
    GLOBAL = "GLOBAL",
}

export enum PolicyResolutionSource {
    SYSTEM = "SYSTEM",
    EXISTING_USER_POLICY = "EXISTING_USER_POLICY",
    NEW_USER_DECISION = "NEW_USER_DECISION",
}