import path from "node:path";

export type WorkerBindMount = {
    source: string;
    destination: string;
    readOnly: boolean;
};

export interface WorkerRuntimeResource {
    environment?(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
    mounts(): readonly WorkerBindMount[];
    close?(): Promise<void>;
}

export function applyWorkerResourceEnvironment(
    base: NodeJS.ProcessEnv,
    resources: readonly WorkerRuntimeResource[],
): NodeJS.ProcessEnv {
    return resources.reduce(
        (environment, resource) => resource.environment?.(environment) ?? environment,
        {...base},
    );
}

export function workerBindMountArguments(mounts: readonly WorkerBindMount[]): string[] {
    const destinations = new Set<string>();
    return mounts.flatMap((mount) => {
        validateMountPath(mount.source, "source");
        validateMountPath(mount.destination, "destination");
        if (destinations.has(mount.destination)) {
            throw new Error(`duplicate worker bind destination: ${JSON.stringify(mount.destination)}`);
        }
        destinations.add(mount.destination);
        return [mount.readOnly ? "--ro-bind" : "--bind", mount.source, mount.destination];
    });
}

function validateMountPath(candidate: string, kind: "source" | "destination"): void {
    if (!path.isAbsolute(candidate) || candidate.includes("\0")) {
        throw new Error(`invalid worker bind ${kind}: ${JSON.stringify(candidate)}`);
    }
    if (candidate === "/") throw new Error(`worker bind ${kind} cannot replace the root`);
}
