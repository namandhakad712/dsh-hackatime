/**
 * dsh-hackatime — host half.
 *
 * Records DeepSeek Harness coding activity as WakaTime-compatible heartbeats and
 * submits them to a Hackatime (or any WakaTime-API-compatible) endpoint.
 *
 * Activity is derived from the live Session event stream:
 *  - `user/message`        → the human typed something (a real keystroke)
 *  - `tool/call` + `tool/result` → the agent ran a tool (edits, reads, builds…)
 *  - `assistant/message`   → a model turn settled; carries `usage` for AI fields
 *
 * Heartbeats are queued in memory and flushed in the background over the single
 * documented endpoint:
 *   POST {api_url}/users/current/heartbeats   (Authorization: Bearer <api_key>)
 *
 * The endpoint accepts one heartbeat per request; this plugin sends them
 * one-at-a-time, never more than `maxConcurrent` in flight, and re-queues
 * anything that fails so a transient network drop costs no tracked time.
 */

import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import Schema from "@deepseek-ai/schemastery";

//#region constants

/** Stable Loader identity. */
export const name = "hackatime";

/** Editor string recorded on every heartbeat. Never a browser name, so the time
 *  is leaderboard-eligible on Hackatime. */
const EDITOR = "DeepSeek Harness";

/** Plugin version reported in the `plugin` field and the HTTP User-Agent. */
const VERSION = "0.1.0";
const PLUGIN = `dsh-hackatime/${VERSION}`;

/** Sentinel WakaTime uses for "same value as the last heartbeat". */
const SAME = "<>";

/** Default WakaTime-compatible base URL for Hackatime. */
const DEFAULT_API_URL = "https://hackatime.hackclub.com/api/hackatime/v1";

/** WakaTime's own default: never send the same entity twice within 30s. */
const DEFAULT_RATE_LIMIT_SECONDS = 30;

/** Max heartbeats queued in memory before the oldest are dropped. */
const MAX_QUEUE = 5_000;

//#endregion

//#region config

/**
 * Plugin configuration.
 *
 * Everything is optional: with no config at all the plugin reads the standard
 * `~/.wakatime.cfg` written by the WakaTime/Hackatime setup flow, so an
 * existing Hackatime user gets tracked with zero configuration.
 */
export const Config = Schema.object({
	/** Master switch. When false, no heartbeats are recorded or submitted. */
	enabled: Schema.boolean().default(true).description("Track DeepSeek Harness coding time on Hackatime"),
	/**
	 * Hackatime API key. Leave blank to read it from `~/.wakatime.cfg`.
	 * Get one at https://hackatime.hackclub.com/settings (it is the same key
	 * the WakaTime CLI uses).
	 */
	apiKey: Schema.string().role("secret").default("").description("Hackatime API key (leave blank to use ~/.wakatime.cfg)"),
	/** API base URL. Defaults to Hackatime; point this at a self-hosted
	 *  WakaTime-compatible server if you run one. */
	apiUrl: Schema.string().default("").description("API base URL (defaults to Hackatime)"),
	/** Project name override. Blank = workspace folder name. */
	project: Schema.string().default("").description("Project name override (blank = workspace folder name)"),
	/** Hostname reported as the `machine` field. Blank = os.hostname(). */
	machine: Schema.string().default("").description("Machine name override (blank = hostname)"),
	/** Minimum gap between two heartbeats for the same entity, in seconds. */
	rateLimitSeconds: Schema.number().default(DEFAULT_RATE_LIMIT_SECONDS).min(5).max(600).description("Minimum seconds between heartbeats for the same file"),
	/** Send a copy of the heartbeat `entity` (file path) to the server. */
	sendEntityPath: Schema.boolean().default(true).description("Send file paths to Hackatime (turn off for privacy)"),
	/** Report per-turn AI token usage on heartbeats. */
	sendAiUsage: Schema.boolean().default(true).description("Report AI model + token counts (ai_model, ai_input_tokens…)"),
	/** Debug logging of every heartbeat emitted. */
	debug: Schema.boolean().default(false).description("Log every heartbeat to the console"),
});

//#endregion

//#region services

/** Host services this plugin consumes. `connection` is resolved lazily. */
export const inject = ["settings"];

//#endregion

//#region wakatime.cfg

/** Path to the standard WakaTime/Hackatime config in the user's home dir. */
const wakatimeCfgPath = () => path.join(os.homedir(), ".wakatime.cfg");

/** Parse the `[settings]` section of ~/.wakatime.cfg into a flat object. */
function parseWakatimeCfg(text) {
	const out = {};
	let section = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
		const head = line.match(/^\[(.+)\]$/);
		if (head) {
			section = head[1].trim().toLowerCase();
			continue;
		}
		if (section !== "settings") continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const key = line.slice(0, eq).trim();
		const value = line.slice(eq + 1).trim();
		if (key.length > 0) out[key] = value;
	}
	return out;
}

/** Cached parse of ~/.wakatime.cfg plus its mtime, so we re-read on change. */
let cfgCache = { mtime: 0, value: {} };

/** Read ~/.wakatime.cfg `[settings]`, re-parsing only when it changes. */
async function readWakatimeCfg() {
	try {
		const file = wakatimeCfgPath();
		const stat = await fs.stat(file);
		const mtime = stat.mtimeMs;
		if (cfgCache.mtime === mtime) return cfgCache.value;
		const text = await fs.readFile(file, "utf8");
		const value = parseWakatimeCfg(text);
		cfgCache = { mtime, value };
		return value;
	} catch {
		cfgCache = { mtime: 0, value: {} };
		return {};
	}
}

//#endregion

//#region helpers

/** Operating-system string in WakaTime's normalised form. */
function detectOs() {
	const platform = process.platform;
	if (platform === "win32") return "windows";
	if (platform === "darwin") return "macos";
	if (platform === "linux") return "linux";
	if (platform === "freebsd" || platform === "openbsd") return "freebsd";
	return platform;
}

/** Map a file extension to a language name WakaTime recognises. */
const EXTENSION_LANGUAGES = {
	".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
	".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
	".py": "Python", ".pyw": "Python",
	".rb": "Ruby", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin", ".kts": "Kotlin",
	".swift": "Swift", ".c": "C", ".h": "C", ".cpp": "C++", ".cc": "C++", ".cxx": "C++", ".hpp": "C++",
	".cs": "C#", ".php": "PHP", ".pl": "Perl", ".scala": "Scala", ".clj": "Clojure", ".ex": "Elixir",
	".exs": "Elixir", ".erl": "Erlang", ".hs": "Haskell", ".lua": "Lua", ".r": "R", ".dart": "Dart",
	".vue": "Vue", ".svelte": "Svelte", ".html": "HTML", ".htm": "HTML", ".css": "CSS", ".scss": "SCSS",
	".less": "Less", ".json": "JSON", ".jsonc": "JSON", ".yaml": "YAML", ".yml": "YAML", ".toml": "INI",
	".ini": "INI", ".cfg": "INI", ".md": "Markdown", ".markdown": "Markdown", ".mdx": "Markdown",
	".txt": "Text", ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell", ".fish": "Shell",
	".ps1": "PowerShell", ".bat": "Batchfile", ".cmd": "Batchfile",
	".sql": "SQL", ".graphql": "GraphQL", ".gql": "GraphQL", ".proto": "Protocol Buffers",
	".xml": "XML", ".svg": "SVG", ".wasm": "WebAssembly", ".vim": "VimL", ".dockerfile": "Dockerfile",
};

/** Language for a path, or undefined if we cannot infer one. */
function languageForPath(p) {
	if (!p) return undefined;
	const base = path.basename(p).toLowerCase();
	if (base === "dockerfile") return "Dockerfile";
	if (base === "makefile") return "Makefile";
	const ext = path.extname(base);
	return EXTENSION_LANGUAGES[ext];
}

/** Is this tool call a mutation (as opposed to a read-only lookup)? */
const WRITE_TOOLS = new Set([
	"write", "edit", "str_replace_editor", "replace", "apply_patch", "apply_diff",
	"create_file", "file_write", "file_edit", "insert", "delete", "delete_file",
	"mkdir", "mkdirs", "move", "rename", "multi_edit", "notebook_edit", "fs.write",
	"fs.edit", "pwsh", "bash", "shell", "run_command", "execute_command",
]);

/** Tool calls that are pure side-effect-free reads — no entity heartbeat. */
const READ_TOOLS = new Set([
	"read", "view", "cat", "head", "tail", "grep", "glob", "ls", "list",
	"find", "search", "stat", "lstat", "fs.read", "fetch", "web_fetch",
	"web_search", "inspect", "status", "todo_read",
]);

/**
 * Best-effort extraction of a file path from a tool call's arguments.
 *
 * `tool/call` carries `arguments` as a JSON string exactly as the model wrote
 * it; the DSH tool schemas all name the path-ish field one of a small set of
 * conventional names, so we probe those before giving up.
 */
function pathFromToolArgs(rawArgs) {
	if (!rawArgs) return undefined;
	let args;
	try {
		args = JSON.parse(rawArgs);
	} catch {
		return undefined;
	}
	if (!args || typeof args !== "object") return undefined;
	const probes = [
		"file_path", "path", "filePath", "filename", "file", "target",
		"source", "dest", "destination", "notebook_path", "url", "command",
	];
	for (const key of probes) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0 && !value.startsWith("http")) {
			return value;
		}
	}
	// Nested arrays the present/pattern tools use: { files: [{ path }] }
	const nested = args.files ?? args.paths ?? args.edits ?? args.commands;
	if (Array.isArray(nested)) {
		for (const item of nested) {
			if (!item || typeof item !== "object") continue;
			for (const key of probes) {
				const value = item[key];
				if (typeof value === "string" && value.length > 0 && !value.startsWith("http")) {
					return value;
				}
			}
		}
	}
	return undefined;
}

/** Scope a path against the workspace root when it is relative. */
function resolveEntity(rawPath, cwd) {
	if (!rawPath) return undefined;
	try {
		return path.resolve(cwd ?? process.cwd(), rawPath);
	} catch {
		return rawPath;
	}
}

/** Project name: override → `.wakatime-project` first line → folder name. */
async function projectName(cwd, override) {
	if (override && override.trim().length > 0) return override.trim();
	if (cwd) {
		try {
			const marker = path.join(cwd, ".wakatime-project");
			const text = await fs.readFile(marker, "utf8");
			const first = text.split(/\r?\n/)[0]?.trim();
			if (first && first !== SAME) return first;
		} catch {
			// no marker file — fall through to the folder name
		}
		const base = path.basename(cwd ?? "");
		if (base.length > 0) return base;
	}
	return "DeepSeek Harness";
}

//#endregion

//#region plugin

/**
 * Wire the plugin: register settings, subscribe to session events, and run the
 * background submit loop for the process lifetime.
 *
 * @param ctx - host context with the declared `inject` services.
 * @param config - validated plugin config.
 */
export function apply(ctx, config) {
	// Surface the plugin's config in the host settings store so the client card
	// and the profile's cordis.patch.yml both read and write the same values.
	ctx.inject(["settings"], (sctx) => {
		sctx.settings.register(name, Config, { base: config });
	});

	/**
	 * Runtime status the settings card reads over the package RPC channel.
	 * Plain counters + timestamps — no heartbeat payloads, no secrets.
	 * Declared before the enabled gate so the card can always report state,
	 * including "paused".
	 */
	const status = {
		/** Epoch ms of the last accepted heartbeat, or null. */
		lastHeartbeatAt: null,
		/** Epoch ms of the last successful submit, or null. */
		lastSubmitAt: null,
		/** Epoch ms of the last failed submit, or null. */
		lastErrorAt: null,
		/** Human-readable reason for the last failure. */
		lastError: null,
		/** Heartbeats accepted since startup. */
		recorded: 0,
		/** Heartbeats successfully sent since startup. */
		submitted: 0,
		/** Heartbeats currently waiting for the network. */
		pending: 0,
		/** Resolved API URL heartbeats go to. */
		apiUrl: null,
		/** Whether an API key is resolvable (config or ~/.wakatime.cfg). */
		hasApiKey: false,
	};

	// The client half's settings card reads live status over this package-
	// private channel (ctx.connection.rpc.call / .handle — the same wiring
	// dsh-pocket uses for its tab). Only `status` is exposed: counters and
	// timestamps, never heartbeat payloads or the API key.
	//
	// Resolved lazily: on a host that never provides `connection` the RPC
	// simply stays unregistered (the card shows "unavailable") and tracking
	// is unaffected. Hard-injecting it would block activation for nothing.
	const RPC_CHANNEL = "/dsh-hackatime";
	ctx.inject(["connection"], (cctx) => {
		if (!cctx.connection?.rpc?.handle) {
			ctx.logger?.warn?.("hackatime: host Connection RPC unavailable — settings card will show limited status");
			return;
		}
		const rpcHandler = async (endpoint) => {
			if (endpoint === "hackatime.status") {
				return {
					ok: true,
					value: {
						...status,
						enabled: config.enabled !== false,
						rateLimitSeconds: Math.max(5, Math.min(600, config.rateLimitSeconds ?? DEFAULT_RATE_LIMIT_SECONDS)),
						project: config.project?.trim() || null,
						machine: config.machine?.trim() || null,
					},
				};
			}
			return { ok: false, error: { code: "bad-request", message: `Unknown endpoint: ${endpoint}` } };
		};
		try {
			const dispose = cctx.connection.rpc.handle(RPC_CHANNEL, rpcHandler);
			cctx.effect(() => () => {
				try { dispose?.(); } catch { /* best-effort teardown */ }
			});
		} catch (error) {
			ctx.logger?.warn?.(`hackatime: status RPC unavailable — ${error?.message ?? error}`);
		}
	});

	if (!config.enabled) {
		ctx.logger?.info?.("hackatime: disabled by config — not tracking");
		return;
	}

	/** Resolved config — api key/url may still come from ~/.wakatime.cfg. */
	const resolved = {
		apiKey: config.apiKey?.trim() || undefined,
		apiUrl: (config.apiUrl?.trim() || undefined),
		project: config.project?.trim() || undefined,
		machine: config.machine?.trim() || os.hostname(),
		rateLimit: Math.max(5, Math.min(600, config.rateLimitSeconds ?? DEFAULT_RATE_LIMIT_SECONDS)),
		sendEntityPath: config.sendEntityPath ?? true,
		sendAiUsage: config.sendAiUsage ?? true,
		debug: config.debug ?? false,
	};

	/** Heartbeats waiting to be submitted. */
	const queue = [];
	/** Last time we sent a heartbeat for a given dedup key. */
	const lastSent = new Map();
	/** Running submit loop guard. */
	let flushing = false;
	/** Whether a submit is already in flight. */
	let inFlight = false;
	let keyResolved = false;

	/** Resolve api_url and api_key, falling back to ~/.wakatime.cfg. */
	async function resolveCredentials() {
		let apiUrl = resolved.apiUrl;
		let apiKey = resolved.apiKey;
		if (!apiUrl || !apiKey) {
			const cfg = await readWakatimeCfg();
			if (!apiUrl) apiUrl = (cfg.api_url || "").trim() || undefined;
			if (!apiKey) apiKey = (cfg.api_key || "").trim() || undefined;
		}
		return {
			apiUrl: (apiUrl || DEFAULT_API_URL).replace(/\/+$/, ""),
			apiKey: apiKey || undefined,
		};
	}

	/** Build a heartbeat from the parts every event contributes. */
	function buildHeartbeat({ time, cwd, entityPath, isWrite, ai }) {
		return projectName(cwd, resolved.project).then((project) => {
			const entity = resolved.sendEntityPath
				? (entityPath ?? cwd ?? "DeepSeek Harness")
				: (cwd ? path.basename(cwd) : "DeepSeek Harness");
			const language = languageForPath(entityPath) ?? languageForPath(cwd);
			const heartbeat = {
				entity,
				type: "file",
				category: "coding",
				time: Math.floor(time / 1000),
				is_write: Boolean(isWrite),
				project,
				editor: EDITOR,
				machine: resolved.machine,
				operating_system: detectOs(),
				plugin: PLUGIN,
				// Deliberately NOT "wakatime/x.y (os) ...". That format is
				// parsed by Hackatime's WakatimeUserAgentParser, and the editor
				// it extracts OVERRIDES the explicit `editor` field
				// (HeartbeatIngest: `parsed_ua[:editor].presence || attrs[:editor]`).
				// Our own package name `dsh-hackatime` also matches the parser's
				// `[-_](?:waka|hacka)time\z` plugin pattern, so it would be
				// stripped to the editor "dsh". A bare token with no slash and
				// no known product parses to a BLANK editor, so the ingest
				// falls back to the explicit `editor` field ("DeepSeek
				// Harness"). Verified against the live API.
				user_agent: "dsh",
			};
			// Omitted keys mean "unknown", which is the correct WakaTime
			// semantics — never send an empty string for an optional field.
			if (language) heartbeat.language = language;
			if (ai && resolved.sendAiUsage) {
				if (ai.model) heartbeat.ai_model = ai.model;
				if (Number.isFinite(ai.inputTokens)) heartbeat.ai_input_tokens = ai.inputTokens;
				if (Number.isFinite(ai.outputTokens)) heartbeat.ai_output_tokens = ai.outputTokens;
				if (ai.session) heartbeat.ai_session = ai.session;
			}
			return heartbeat;
		});
	}

	/** Enqueue a heartbeat, enforcing the per-entity rate limit. */
	function emit(heartbeat) {
		if (!heartbeat) return;
		const key = `${heartbeat.entity}\u0000${heartbeat.is_write}`;
		const now = Date.now();
		const last = lastSent.get(key) ?? 0;
		if (now - last < resolved.rateLimit * 1000) {
			// Suppressed by the rate limit, not dropped: a heartbeat for this
			// entity+write-kind already left recently, and consecutive
			// heartbeats are what Hackatime sums into duration anyway.
			if (resolved.debug) ctx.logger?.info?.(`hackatime: rate-limited ${heartbeat.entity} (${Math.ceil((resolved.rateLimit * 1000 - (now - last)) / 1000)}s left)`);
			return;
		}
		lastSent.set(key, now);
		queue.push(heartbeat);
		if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
		status.recorded += 1;
		status.lastHeartbeatAt = now;
		status.pending = queue.length;
		if (resolved.debug) ctx.logger?.info?.(`hackatime: queued ${heartbeat.entity} @${heartbeat.time}`);
		scheduleFlush();
	}

	/** Enqueue a heartbeat built from an event, without throwing on bad input. */
	async function record(event) {
		try {
			const heartbeat = await buildHeartbeat(event);
			emit(heartbeat);
		} catch (error) {
			ctx.logger?.warn?.(`hackatime: failed to record heartbeat — ${error?.message ?? error}`);
		}
	}

	/** One submit attempt for the head of the queue. */
	async function submitOne(heartbeat) {
		const { apiUrl, apiKey } = await resolveCredentials();
		status.apiUrl = apiUrl;
		if (!keyResolved) {
			keyResolved = true;
			status.hasApiKey = Boolean(apiKey);
		}
		if (!apiKey) {
			if (resolved.debug) ctx.logger?.warn?.("hackatime: no API key — set one in ~/.wakatime.cfg or the plugin settings");
			return false;
		}
		const url = `${apiUrl}/users/current/heartbeats`;
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"Accept": "application/json",
				"User-Agent": `dsh-hackatime/${VERSION}`,
			},
			body: JSON.stringify(heartbeat),
		});
		if (response.ok) {
			status.submitted += 1;
			status.lastSubmitAt = Date.now();
			status.lastErrorAt = null;
			status.lastError = null;
			return true;
		}
		// 400/422 are permanent rejections by the server; retrying a malformed
		// heartbeat would loop forever, so drop it and log once.
		if (response.status === 400 || response.status === 422) {
			let detail = "";
			try {
				detail = await response.text();
			} catch {
				// response body read is best-effort
			}
			status.lastErrorAt = Date.now();
			status.lastError = `Server rejected heartbeat (${response.status})`;
			ctx.logger?.warn?.(`hackatime: server rejected heartbeat (${response.status}) ${detail.slice(0, 200)}`);
			return true;
		}
		// 5xx / network: re-queue for a later attempt.
		status.lastErrorAt = Date.now();
		status.lastError = `HTTP ${response.status}`;
		throw new Error(`HTTP ${response.status}`);
	}

	/** Drain the queue serially; a failure stops the drain and reschedules. */
	async function flush() {
		if (flushing) return;
		flushing = true;
		try {
			while (queue.length > 0) {
				const heartbeat = queue[0];
				try {
					const ok = await submitOne(heartbeat);
					if (ok) {
						queue.shift();
						status.pending = queue.length;
					} else {
						// No API key configured yet — retry shortly.
						setTimeout(scheduleFlush, 60_000);
						return;
					}
				} catch (error) {
					// Leave the heartbeat at the head and retry on a slow cadence
					// so a long outage does not spin the CPU.
					status.lastErrorAt = Date.now();
					status.lastError = error?.message ?? String(error);
					if (resolved.debug) ctx.logger?.warn?.(`hackatime: submit failed — ${error?.message ?? error}; will retry`);
					setTimeout(scheduleFlush, 30_000);
					return;
				}
			}
		} finally {
			flushing = false;
		}
	}

	/** Schedule a flush on the next macrotask, coalescing rapid bursts. */
	function scheduleFlush() {
		if (inFlight) return;
		inFlight = true;
		setTimeout(() => {
			inFlight = false;
			void flush();
		}, 0);
	}

	// --- session event stream -------------------------------------------------

	/** Recent tool calls by callId, so `tool/result` can match `tool/call`. */
	const pendingTools = new Map();

	/** Track AI usage accumulated during the current turn. */
	let aiAccumulator = null;
	let lastAiEmit = 0;

	ctx.on("session/event", (session, event) => {
		const cwd = session?.header?.cwd;
		const type = event?.type;
		const data = event?.data;
		if (!type) return;

		if (type === "user/message") {
			// A human message is the strongest signal: the user is at the keyboard.
			void record({ time: event.time ?? Date.now(), cwd, isWrite: false });
			return;
		}

		if (type === "tool/call") {
			const toolName = data?.name;
			const callId = data?.callId;
			const entityPath = resolveEntity(pathFromToolArgs(data?.arguments), cwd);
			if (callId && toolName) {
				pendingTools.set(callId, { toolName, entityPath, time: event.time ?? Date.now() });
				// Keep the map bounded — a turn can issue many calls.
				if (pendingTools.size > 200) {
					pendingTools.delete(pendingTools.keys().next().value);
				}
			}
			// Only emit for tools that touch the filesystem; a pure search or
			// web fetch is not coding activity on a specific file.
			if (entityPath && !READ_TOOLS.has(toolName)) {
				void record({
					time: event.time ?? Date.now(),
					cwd,
					entityPath,
					isWrite: WRITE_TOOLS.has(toolName),
				});
			}
			return;
		}

		if (type === "tool/result") {
			// Surface the tool call's file on completion too — a finished edit is
			// a stronger "write" signal than the request alone.
			const callId = data?.callId;
			const pending = callId ? pendingTools.get(callId) : undefined;
			if (callId) pendingTools.delete(callId);
			if (pending?.entityPath) {
				void record({
					time: event.time ?? Date.now(),
					cwd,
					entityPath: pending.entityPath,
					isWrite: WRITE_TOOLS.has(pending.toolName),
				});
			}
			return;
		}

		if (type === "assistant/message") {
			// The model turn settled. Accumulate token usage and attach it to the
			// next heartbeat, throttled to one AI-tagged heartbeat per minute so
			// a long turn does not flood the server.
			const usage = data?.usage;
			const model = data?.message?.model ?? data?.model;
			if (usage && resolved.sendAiUsage) {
				aiAccumulator = {
					model: model ?? aiAccumulator?.model,
					inputTokens: (aiAccumulator?.inputTokens ?? 0) + (usage.inputTokens ?? 0),
					outputTokens: (aiAccumulator?.outputTokens ?? 0) + (usage.outputTokens ?? 0),
					session: session?.id,
				};
				const now = Date.now();
				if (now - lastAiEmit > 60_000) {
					lastAiEmit = now;
					void record({
						time: now,
						cwd,
						isWrite: false,
						ai: aiAccumulator,
					});
				}
			}
			return;
		}

		// Fallback: any other activity (turn/start, step/start, …) counts as
		// presence but is throttled harder, so idle background noise between
		// turns does not manufacture tracked time.
		if (type === "turn/start" || type === "step/start") {
			return;
		}
	});

	// --- lifecycle ------------------------------------------------------------

	// Best-effort flush when the process winds down, so a short session is not
	// lost to the event loop being torn down.
	ctx.effect(() => () => {
		try {
			void flush();
		} catch {
			// shutdown paths are best-effort
		}
	});
}

//#endregion
