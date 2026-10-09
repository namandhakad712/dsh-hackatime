import type { Context } from "@deepseek-ai/cordis";

/** Stable Loader identity. */
export declare const name: string;
/** Client services this card consumes. */
export declare const inject: string[];
/** Client entry point: registers the settings card in the host UI. */
export declare function apply(ctx: Context): void;
