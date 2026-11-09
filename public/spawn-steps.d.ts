export declare const SPAWN_STEPS: { key: string; label: string }[];
export declare const SPAWN_HINT: string;
export declare const HELLO_STEP: { key: string; label: string };
export declare function spawnStepStates(current: unknown, opts?: { hello?: boolean }): { key: string; label: string; state: "done" | "on" | "todo" }[];
export declare function spawnLoaderTitle(name: unknown): string;
