import type { Context } from "@deepseek-ai/cordis";

/** Plugin configuration. */
export interface Config {
	enabled: boolean;
	apiKey: string;
	apiUrl: string;
	project: string;
	machine: string;
	rateLimitSeconds: number;
	sendEntityPath: boolean;
	sendAiUsage: boolean;
	debug: boolean;
}

/** Stable Loader identity. */
export declare const name: string;
/** Host services this plugin consumes. */
export declare const inject: string[];
/** Plugin entry point. */
export declare function apply(ctx: Context, config: Config): void;
export { Config };
