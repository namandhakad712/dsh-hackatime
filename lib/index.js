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
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { spawn as nodeSpawn } from "node:child_process";
import Schema from "@deepseek-ai/schemastery";

//#region constants

/** Stable Loader identity. */
export const name = "hackatime";

/** Editor string recorded on every heartbeat. Never a browser name, so the time
 *  is leaderboard-eligible on Hackatime. */
const EDITOR = "DeepSeek Harness";

/** Plugin version reported in the `plugin` field and the HTTP User-Agent.
 *  Kept in sync with package.json — the settings card shows it and the
 *  auto-updater compares it against the npm latest tag. */
const VERSION = "0.4.0";
const PLUGIN = `dsh-hackatime/${VERSION}`;

/** Sentinel WakaTime uses for "same value as the last heartbeat". */
const SAME = "<>";

/** Default WakaTime-compatible base URL for Hackatime. */
const DEFAULT_API_URL = "https://hackatime.hackclub.com/api/hackatime/v1";

/** WakaTime's own default: never send the same entity twice within 30s. */
const DEFAULT_RATE_LIMIT_SECONDS = 30;

/** Max heartbeats queued in memory before the oldest are dropped. */
const MAX_QUEUE = 5_000;

/**
 * Compare two semver-ish strings. Returns >0 if `a` is newer, <0 if `b` is,
 * 0 if equal. Tolerates pre-release suffixes by comparing only the numeric
 * release segments, which is all this plugin's own tags ever need.
 */
function compareVersions(a, b) {
	const parse = (v) => String(v ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
	const [aa, ab, ac] = parse(a);
	const [ba, bb, bc] = parse(b);
	return (aa - ba) || (ab - bb) || (ac - bc);
}

/**
 * Run the documented self-update: `dsh plugin --profile <p> update
 * dsh-hackatime --latest -w`. Spawned with a shell on Windows because a bare
 * `spawn("dsh")` resolves to the extensionless POSIX shim (ENOENT), and Node
 * 22+ rejects a direct `.cmd` spawn (CVE-2024-27980) — the same reason
 * dsh-pocket uses `shell: process.platform === "win32"`.
 *
 * @param {string} profile - profile to update in (`web` when unknown).
 * @returns {Promise<{ok: boolean, output?: string, error?: string}>}
 */
function runSelfUpdate(profile, { timeoutMs = 180_000 } = {}) {
	const spawn = nodeSpawn;
	return new Promise((resolve) => {
		const child = spawn("dsh", ["plugin", "--profile", profile, "update", "dsh-hackatime", "--latest", "-w"], {
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32",
		});
		let out = "";
		const onData = (chunk) => {
			out += String(chunk);
			if (out.length > 4000) out = out.slice(-4000);
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		const timer = setTimeout(() => { try { child.kill(); } catch { /* already exited */ } }, timeoutMs);
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve({ ok: code === 0, output: out.slice(-800) });
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			resolve({ ok: false, error: error.message });
		});
	});
}

/** Unwrap one cosmokit volatile reference to its current snapshot.
 *
 * dsh-cordis resolves every `Schema.x().volatile()` field to a *reference*
 * object (`{ get, [write] }`) rather than the plain value, so `config.apiKey`
 * is the reference, not the string. Reading `.trim()` off it throws
 * `config.apiKey?.trim is not a function` and kills the whole plugin at
 * activation. Every volatile field must be unwrapped through `.get()` first.
 * Non-reference values pass through unchanged, so this is safe on plain
 * configs too (older dsh, plain patches, tests).
 *
 * @template T
 * @param {T} value - a resolved config value (possibly a volatile reference).
 * @returns {T} the plain value.
 */
function unwrapVolatile(value) {
	if (value !== null && typeof value === "object" && typeof value.get === "function" && typeof value.set !== "function") {
		try {
			return value.get();
		} catch {
			return value;
		}
	}
	return value;
}

/** endpoint segment characters (aligned with dsh-client-connection). */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

/** rpcId used when the client-request envelope fails validation. */
const INVALID_REQUEST_RPC_ID = "invalid-request";

/** Loopback hostnames trusted by the fallback fence below. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * A profile name must be a plain filesystem-safe token. This is enforced
 * before the value is ever handed to a spawned `dsh plugin --profile <p>`,
 * because that spawn runs through a shell on Windows where shell
 * metacharacters in the argument would be executed.
 */
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * The complete set of config keys this plugin ever accepts. RPC patches are
 * filtered against it before they reach the Settings service or the profile
 * patch file: an arbitrary key (say, `__proto__`) has no business in our
 * namespace, and this closes the whole "unknown key lands in the YAML" class
 * without needing to know what cordis/schemastery does with it downstream.
 */
const CONFIG_KEYS = new Set([
	"enabled", "apiKey", "apiUrl", "project", "machine",
	"rateLimitSeconds", "sendEntityPath", "sendAiUsage", "debug", "autoUpdate",
]);

/**
 * Filter an incoming `config.set` patch down to the known keys and coerce it
 * to a plain object. Only own enumerable string keys are kept, so a JSON
 * payload's `__proto__` (which JSON.parse exposes as an own property) is
 * dropped here rather than forwarded into the config merge.
 */
function sanitizePatch(payload, cctx) {
	const patch = payload && typeof payload === "object" ? payload : {};
	const clean = Object.create(null);
	for (const key of Object.keys(patch)) {
		if (!CONFIG_KEYS.has(key)) {
			cctx?.logger?.warn?.(`hackatime: config.set dropped unknown key ${JSON.stringify(key)}`);
			continue;
		}
		clean[key] = patch[key];
	}
	return clean;
}

/**
 * Blank out the API key on any config value handed back over RPC. The card
 * treats the field as write-only: it learns whether a key exists from the
 * status payload's `hasApiKey` and speaks new keys through `config.set`, so
 * nothing legitimate needs the stored secret on the read path.
 */
function maskSecrets(value) {
	if (!value || typeof value !== "object") return value;
	return { ...value, apiKey: "" };
}

/**
 * The auth gate for the plugin's web route. Prefers the host's own
 * `ctx.connection.requestRejection(req)` (dsh v0.1.5-alpha.1+), which applies
 * the full Host/Origin fence plus the signed browser-session cookie — the
 * exact check dsh's `/api` route performs. Called as a bound method: extracting
 * it as a bare function drops `this` (trustedHosts/browserAuth) and turns every
 * request into a 403 (dsh-pocket issue #117 hit exactly this).
 *
 * Resolved per request by `apply` via `connectionResolve` so a connection
 * service that appears after mount is picked up; when no service exists,
 * `isTrustedLoopbackRequest` takes over.
 */
let connectionResolve = undefined;

/**
 * Minimal trust fence for builds without `connection.requestRejection`: allow
 * only a loopback Host whose Origin (if any) matches it, and never a
 * cross-site fetch. This mirrors the loopback branch of dsh's
 * `isTrustedApiRequest` and is what dsh-pocket falls back to in the same
 * situation. The browser-side caller passes this because the settings page is
 * same-origin; a stray local process or a rebinding site does not.
 */
function isTrustedLoopbackRequest(req) {
	const host = req.headers?.host;
	if (!host) return false;
	const hostName = host.split(":")[0];
	if (!LOOPBACK_HOSTNAMES.has(hostName)) return false;
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = req.headers.origin;
	if (origin === undefined) return true;
	try { return new URL(origin).host === host; } catch { return false; }
}

/**
 * Decide the rejection status for one request, or `undefined` when it may
 * proceed. Never throws: a broken gate must fail closed (403), not open.
 */
function rejectionFor(req) {
	const gate = typeof connectionResolve === "function" ? connectionResolve() : undefined;
	if (typeof gate === "function") {
		try {
			const rejection = gate(req);
			return rejection === undefined ? undefined : rejection;
		} catch { return 403; }
	}
	return isTrustedLoopbackRequest(req) ? undefined : 403;
}

/** Upper bound on one RPC body — these endpoints only carry small control JSON. */
const RPC_BODY_MAX = 8 * 1024 * 1024;

/** Pull the endpoint out of a `${channel}/${endpoint}` path, or undefined. */
function endpointFromPath(channel, pathname) {
	if (!pathname.startsWith(`${channel}/`)) return undefined;
	const endpoint = pathname.slice(channel.length + 1);
	if (endpoint.split("/").some((seg) => seg === "" || seg === "." || seg === ".." || !ENDPOINT_SEGMENT_PATTERN.test(seg))) {
		return undefined;
	}
	return endpoint;
}

/**
 * Wrap an RPC handler as a web-server route handler. The browser sends a
 * client-request envelope `{ rpcId, method, payload }` and expects a
 * server-response envelope `{ type: "server-response", rpcId, result }` back —
 * this mirrors dsh-client-connection's `/api` transport so the browser's
 * `ctx.connection.rpc.call` reaches us unchanged. Status codes follow the same
 * convention: 404 (not POST / no endpoint), 415 (content type), 400 (bad JSON),
 * 200 with an error envelope for a bad method or a failed handler.
 *
 * The route answers ONLY an authenticated caller. The gate is the same one
 * dsh's own `/api` route uses — `ctx.connection.requestRejection(req)` — which
 * checks the Host/Origin fence (DNS-rebinding defense, 403) and then the signed
 * browser-session cookie (401). On builds without that method we fall back to
 * the loopback/Origin-only fence dsh-pocket uses for the same situation. This
 * keeps the channel private: any local process could otherwise read the API
 * key out of `config.get`, or re-point `apiUrl` to exfiltrate it.
 *
 * Takes the channel and a logger explicitly so the helper stays free of module
 * state that is only defined inside `apply`.
 */
function makeWebRouteHandler(channel, rpcHandler, logger) {
	const send = (res, status, body, contentType = "text/plain; charset=utf-8") => {
		try {
			res.writeHead(status, { "content-type": contentType });
			res.end(body);
		} catch { /* socket already gone */ }
	};
	const reject = (res, status) => send(res, status, status === 401 ? "unauthorized" : "forbidden");

	return async (req, res) => {
		// Auth first, before any body is read: an unauthenticated caller must
		// never reach the handler, and rejecting early costs nothing.
		const rejection = rejectionFor(req);
		if (rejection !== undefined) return reject(res, rejection);

		const url = new URL(req.url ?? "/", "http://localhost");
		const endpoint = endpointFromPath(channel, url.pathname);
		if (req.method !== "POST" || endpoint === undefined) {
			return send(res, 404, "not found");
		}
		const mediaType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
		if (mediaType !== "application/json") {
			return send(res, 415, "content type must be application/json");
		}

		const abort = new AbortController();
		res.on?.("close", () => { if (!res.writableEnded) abort.abort(); });

		// Bound the body so a client cannot buffer unbounded memory.
		const declared = req.headers["content-length"];
		if (declared !== undefined && Number(declared) > RPC_BODY_MAX) {
			send(res, 413, "payload too large");
			req.destroy();
			return;
		}
		const chunks = [];
		let received = 0;
		let tooLarge = false;
		for await (const chunk of req) {
			received += chunk.length;
			if (received > RPC_BODY_MAX) { tooLarge = true; break; }
			chunks.push(chunk);
		}
		if (tooLarge) {
			send(res, 413, "payload too large");
			req.destroy();
			return;
		}

		let body;
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			return send(res, 400, "body is not JSON");
		}

		const rpcId = body && typeof body.rpcId === "string" ? body.rpcId : INVALID_REQUEST_RPC_ID;
		const method = body && typeof body.method === "string" ? body.method : null;
		const envelope = (result) => JSON.stringify({ type: "server-response", rpcId, result });
		if (rpcId === INVALID_REQUEST_RPC_ID || method === null) {
			return send(res, 200, envelope({ ok: false, error: { code: "bad-request", message: "invalid client-request message" } }), "application/json");
		}
		if (method !== endpoint) {
			return send(res, 200, envelope({ ok: false, error: { code: "bad-request", message: `method ${JSON.stringify(method)} does not match endpoint ${JSON.stringify(endpoint)}` } }), "application/json");
		}

		try {
			const result = await rpcHandler(endpoint, body.payload, abort.signal);
			return send(res, 200, envelope(result), "application/json");
		} catch (error) {
			logger?.error?.(`hackatime: rpc ${endpoint} failed — ${error?.message ?? error}`);
			return send(res, 500, `handler failure: ${String(error?.message ?? error)}`);
		}
	};
}

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
	enabled: Schema.boolean().default(true).volatile().description("Track DeepSeek Harness coding time on Hackatime"),
	/**
	 * Hackatime API key. Leave blank to read it from `~/.wakatime.cfg`.
	 * Get one at https://hackatime.hackclub.com/api-key (it is the same key
	 * the WakaTime CLI uses).
	 */
	apiKey: Schema.string().role("secret").default("").volatile().description("Hackatime API key (leave blank to use ~/.wakatime.cfg)"),
	/** API base URL. Defaults to Hackatime; point this at a self-hosted
	 *  WakaTime-compatible server if you run one. */
	apiUrl: Schema.string().default("").volatile().description("API base URL (defaults to Hackatime)"),
	/** Project name override. Blank = workspace folder name. */
	project: Schema.string().default("").volatile().description("Project name override (blank = workspace folder name)"),
	/** Hostname reported as the `machine` field. Blank = os.hostname(). */
	machine: Schema.string().default("").volatile().description("Machine name override (blank = hostname)"),
	/** Minimum gap between two heartbeats for the same entity, in seconds. */
	rateLimitSeconds: Schema.number().default(DEFAULT_RATE_LIMIT_SECONDS).min(5).max(600).volatile().description("Minimum seconds between heartbeats for the same file"),
	/** Send a copy of the heartbeat `entity` (file path) to the server. */
	sendEntityPath: Schema.boolean().default(true).volatile().description("Send file paths to Hackatime (turn off for privacy)"),
	/** Report per-turn AI token usage on heartbeats. */
	sendAiUsage: Schema.boolean().default(true).volatile().description("Report AI model + token counts (ai_model, ai_input_tokens…)"),
	/** Debug logging of every heartbeat emitted. */
	debug: Schema.boolean().default(false).volatile().description("Log every heartbeat to the console"),
	/**
	 * Automatically install the newest published `dsh-hackatime` when the host
	 * sees a later npm version. Runs `dsh plugin update --latest`, the same
	 * command the card's manual button runs. Turn it off if you pin versions.
	 */
	autoUpdate: Schema.boolean().default(true).volatile().description("Automatically update dsh-hackatime when a newer version is published"),
});

//#endregion

//#region services

/**
 * Host services this plugin consumes. `connection` and `webServer` are
 * resolved lazily inside the inject callback: dsh >= 0.1.5-alpha.1 routes the
 * browser RPC over the web server, older builds over `connection.rpc.handle`,
 * and only the runtime knows which is present.
 */
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

//#region rpc

/**
 * Build the RPC handler shared by both transports.
 *
 * Endpoints:
 *  - `hackatime.status` — live tracking state plus the resolved config view.
 *  - `hackatime.config.get` — the stored config, schema defaults applied.
 *  - `hackatime.config.set` — apply a patch through the settings service.
 *  - `hackatime.config.unset` — remove keys (e.g. clear a stored API key).
 *  - `hackatime.version` — current vs latest published, for the update banner.
 *  - `hackatime.update` — run the documented `dsh plugin update` self-update.
 *
 * Every endpoint returns the `{ ok, value }` / `{ ok, error }` envelope so the
 * browser side has one shape to unwrap on either transport.
 *
 * @param {{ readConfig: () => Promise<object>, cctx: object, status: object, config: object }} deps
 */
/**
 * Resolve the profile context (dir + patch path) the same way dsh-config-editor
 * does, tolerating the several shapes dsh exposes it through across versions.
 * @param {object} cctx
 * @returns {{ dir: string, patchPath: string } | undefined}
 */
function resolveProfileContext(cctx) {
	const candidates = [
		cctx?.settings?.ownerContext?.profileContext,
		cctx?.settings?.ownerContext,
		cctx?.root?.profileContext,
		cctx?.profileContext,
	];
	for (const candidate of candidates) {
		if (candidate && typeof candidate.dir === "string" && typeof candidate.patchPath === "string") return candidate;
	}
	return undefined;
}

/**
 * Persist the plugin's config block into the profile patch layer
 * (`<profile>/cordis.patch.yml`).
 *
 * Mirrors the document surgery in `ConfigEditor.edit` — same `yaml` AST
 * round-trip that preserves comments and `!!js` expressions in neighbouring
 * entries — minus the two `reconcileProfilePatches` calls that the packaged
 * host cannot perform (see {@link writeConfigViaLoader}).
 *
 * The `yaml` package is resolved from the *profile's* node_modules by absolute
 * path: this plugin's own dependency graph does not (and should not) carry a
 * YAML library, and every dsh profile that has a ConfigEditor already has it.
 *
 * @param {{ profileContext: { dir: string, patchPath: string }, ns: string, pluginName: string, next: object }} deps
 * @returns {Promise<void>}
 */
async function persistProfileConfig({ profileContext, ns, pluginName, next }) {
	const yamlUrl = pathToFileURL(path.join(profileContext.dir, "node_modules", "yaml", "dist", "index.js")).href;
	/** CommonJS module: named exports are surfaced by Node's interop layer, with
	 *  `.default` as a fallback for bundler-shaped builds. */
	const mod = await import(yamlUrl);
	const { parseDocument, Scalar, isMap, isSeq, visit } = mod.default?.parseDocument ? mod.default : mod;

	let before;
	try {
		before = await fs.readFile(profileContext.patchPath, "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		before = "[]\n";
	}
	const document = parseDocument(before, { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value) => value }] });
	if (document.errors[0] !== undefined) throw document.errors[0];
	if (!isSeq(document.contents)) throw new Error("Profile patch must be a YAML sequence");
	document.contents.flow = false;

	const items = document.contents.items;
	const matches = (row, index) =>
		isMap(row) &&
		document.getIn([index, "id"]) === ns &&
		!row.has("insert") &&
		(!row.has("name") || document.getIn([index, "name"]) === pluginName);

	if (Object.keys(next).length === 0) {
		/** Setting everything back to inherited defaults: drop the override, and
		 *  prune the row when only id/name remain. */
		for (let index = items.length - 1; index >= 0; index--) {
			const row = items[index];
			if (!matches(row, index)) continue;
			row.delete("config");
			if (row.items.length === Number(row.has("id")) + Number(row.has("name"))) document.delete(index);
		}
	} else {
		const index = items.findLastIndex(matches);
		if (index < 0) document.add(document.createNode({ id: ns, name: pluginName, config: next }));
		else document.setIn([index, "config"], document.createNode(next));
	}
	/** Re-serialise any single-key `__jsExpr` maps as `!!js` scalars so existing
	 *  expression overrides elsewhere in the file survive the round-trip. */
	visit(document, {
		Map(_key, node) {
			if (node.items.length !== 1 || typeof node.get("__jsExpr") !== "string") return;
			const expression = new Scalar(node.get("__jsExpr"));
			expression.tag = "tag:yaml.org,2002:js";
			return expression;
		},
	});

	/** Temp-file + rename, so a crash mid-write cannot truncate the profile.
	 *
	 * The temp path carries a random suffix and is created exclusively (flag
	 * "wx"): a predictable name is a symlink pre-plant target, and exclusive
	 * create fails rather than following such a link. The final rename lands
	 * only on a path that is still a regular file (or absent), so a link
	 * swapped in between cannot redirect the write. */
	const tmp = `${profileContext.patchPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
	let handle;
	try {
		handle = await fs.open(tmp, "wx", 0o600);
		await handle.writeFile(String(document));
		await handle.close();
		handle = null;
		let target;
		try {
			target = await fs.lstat(profileContext.patchPath);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			target = null;
		}
		if (target !== null && !target.isFile()) {
			throw new Error("profile patch path is not a regular file; refusing to replace it");
		}
		await fs.rename(tmp, profileContext.patchPath);
	} finally {
		if (handle !== null) { try { await handle.close(); } catch { /* already closed */ } }
		try { await fs.rm(tmp, { force: true }); } catch { /* best effort */ }
	}
}

/**
 * Apply a config patch directly through the Loader entry, bypassing the
 * Settings service's profile-reload path.
 *
 * `settings.update` funnels into `configEditor.edit`, which calls
 * `reconcileProfilePatches` — and that needs the root Include entry from a
 * module-level WeakMap in `@deepseek-ai/dsh-app-boot`. When the host core and
 * the profile plugins load two physical copies of that module (the packaged
 * Electron app boots from `app.asar` while profile plugins resolve from the
 * profile's own `node_modules`), the WeakMaps differ and every write dies with
 * `profile reload requires the root Include entry` — for every plugin, not
 * just ours. dsh-pocket sidesteps this by persisting its own files.
 *
 * The Loader entry's own `update({ config })` has a volatile-only fast path
 * (`_commitVolatile`) that commits straight into the running fiber's volatile
 * references with no reload at all, which is a perfect fit here: every field
 * in our Config schema is `.volatile()`. Persistence is replicated from
 * `ConfigEditor.edit` minus the broken reconciles, so the change also survives
 * a host restart.
 *
 * @param {{ cctx: object, ns: string, patch: object, readConfig: () => Promise<object>, logger?: object }} deps
 * @returns {Promise<{ ok: boolean, value?: object, error?: { code: string, message: string } }>}
 */
async function writeConfigViaLoader({ cctx, ns, patch, readConfig }) {
	const root = cctx?.root ?? cctx;
	/** The Loader service sits at the root; reach it through whichever handle the
	 *  inject context exposes (older dsh has no `root` getter on every context). */
	const loader = root?.loader ?? root?.get?.("loader") ?? cctx?.settings?.ownerContext?.loader;
	if (!loader || typeof loader.entries !== "function") {
		return { ok: false, error: { code: "loader-unavailable", message: "the Loader service is not reachable from this context" } };
	}
	/** Profile-level entries are the ones whose parent tree is the root Include. */
	const entry = loader
		.entries()
		.find((row) => row?.options?.id === ns && row?.parent?.tree?.ctx?.fiber?.entry?.id === "include");
	if (!entry) {
		return { ok: false, error: { code: "entry-not-found", message: `no profile loader entry for "${ns}"` } };
	}

	/** Merge into the entry's *raw override*, not the resolved values — the
	 *  override only holds the fields the user actually set, so unset keys keep
	 *  inheriting the schema defaults instead of being pinned by a full write.
	 *  Null values ride through so Entry.update deletes them itself, exactly as
	 *  ConfigEditor.edit hands `next` to the Loader. */
	const next = { ...(entry.options.config ?? {}), ...patch };

	const profileContext = resolveProfileContext(cctx);
	/** `entry.update` resolves the merged config through the schema first and
	 *  throws on a violation, so a bad value never reaches the profile file. */
	try {
		await entry.update({ config: next });
	} catch (error) {
		return { ok: false, error: { code: "config-rejected", message: String(error?.message ?? error) } };
	}
	/** Entry.update has now merged into entry.options.config and stripped the
	 *  nulls itself; persist that normalized form so the file matches the live
	 *  state. Empty strings are dropped too: a text field the user left blank
	 *  is not an override (the schema default applies), and leaving them in
	 *  would keep a "blank" entry alive in the patch file forever. */
	const stored = { ...(entry.options.config ?? {}) };
	for (const [key, value] of Object.entries(stored)) {
		if (value === null || value === undefined || value === "") Reflect.deleteProperty(stored, key);
	}

	/** The live apply already happened; persistence is best-effort so a missing
	 *  `yaml` module or an unwritable profile degrades to "until restart"
	 *  instead of failing the whole save. */
	if (profileContext) {
		try {
			await persistProfileConfig({ profileContext, ns, pluginName: entry.options.name, next: stored });
		} catch (error) {
			cctx.logger?.warn?.(`hackatime: config applied live but not persisted (${String(error?.message ?? error)})`);
		}
	} else {
		cctx.logger?.warn?.("hackatime: profile context unavailable — config applied live only");
	}
	return { ok: true, value: await readConfig() };
}

function makeRpcHandler({ readConfig, cctx, status, config }) {
	return async (endpoint, payload) => {
		if (endpoint === "hackatime.status") {
			// `hasApiKey`/`apiUrl` are derived live, not read off the submit-time
			// flag: a user who pastes a key while idle must see the "No API key"
			// warning clear immediately, without waiting for the first heartbeat.
			const liveKey = unwrapVolatile(config.apiKey)?.trim() || undefined;
			const liveUrl = unwrapVolatile(config.apiUrl)?.trim() || undefined;
			let hasApiKey = Boolean(liveKey);
			let apiUrl = (liveUrl || DEFAULT_API_URL).replace(/\/+$/, "");
			if (!hasApiKey || !liveUrl) {
				const cfg = await readWakatimeCfg();
				if (!hasApiKey) hasApiKey = Boolean((cfg.api_key || "").trim());
				if (!liveUrl) apiUrl = ((cfg.api_url || "").trim() || DEFAULT_API_URL).replace(/\/+$/, "");
			}

			// The project the *active* window is working in. The card sends the
			// workspace path of the session the user is actually looking at
			// (the main-view session), so the status reflects what is truly
			// being timed right now instead of whichever session happened to
			// emit the last event. Fall back to the last recorded session when
			// the card cannot resolve a foreground window.
			const activeCwd = typeof payload?.activeCwd === "string" ? payload.activeCwd.trim() : "";
			let activeProject = null;
			if (activeCwd) {
				try {
					activeProject = await projectName(activeCwd, unwrapVolatile(config.project));
				} catch (error) {
					cctx.logger?.warn?.(`hackatime: could not resolve the active project — ${error?.message ?? error}`);
				}
			}

			return {
				ok: true,
				value: {
					...status,
					enabled: unwrapVolatile(config.enabled) !== false,
					rateLimitSeconds: Math.max(5, Math.min(600, unwrapVolatile(config.rateLimitSeconds) ?? DEFAULT_RATE_LIMIT_SECONDS)),
					project: unwrapVolatile(config.project)?.trim() || null,
					machine: unwrapVolatile(config.machine)?.trim() || null,
					hasApiKey,
					apiUrl,
					// The workspace path the card reported (null when unknown).
					activeCwd: activeCwd || null,
					// The project name that would be attributed if a heartbeat
					// landed right now — override → .wakatime-project → folder.
					activeProject,
				},
			};
		}
		if (endpoint === "hackatime.config.get") {
			try {
				// The API key is write-only on this channel. The card never
				// needs the stored value back — it learns "is a key set?" from
				// `hasApiKey` on the status payload and speaks a fresh key
				// through `config.set`. Returning the raw secret here would put
				// it on a plaintext local HTTP response readable by any process
				// on the machine.
				const value = await readConfig();
				return { ok: true, value: maskSecrets(value) };
			} catch (error) {
				return { ok: false, error: { code: "config-read-failed", message: String(error?.message ?? error) } };
			}
		}
		if (endpoint === "hackatime.config.set") {
			const patch = sanitizePatch(payload, cctx);
			// Primary: the documented Settings service write. Falls back to the
			// Loader entry when the profile-reload path is unavailable (packaged
			// host + profile-resolved dsh-app-boot), so the card still saves.
			try {
				await cctx.settings.update(name, patch);
				return { ok: true, value: maskSecrets(await readConfig()) };
			} catch (primaryError) {
				const fallback = await writeConfigViaLoader({ cctx, ns: name, patch, readConfig });
				if (fallback.ok) {
					cctx.logger?.warn?.(`hackatime: settings.update failed (${String(primaryError?.message ?? primaryError)}); saved through the Loader entry instead`);
					return { ok: true, value: maskSecrets(fallback.value) };
				}
				return { ok: false, error: { code: "config-write-failed", message: `${String(primaryError?.message ?? primaryError)} — fallback also failed: ${fallback.error?.message ?? "unknown"}` } };
			}
		}
		if (endpoint === "hackatime.config.unset") {
			const keys = Array.isArray(payload?.keys) ? payload.keys.filter((k) => CONFIG_KEYS.has(k)) : [];
			if (keys.length === 0) return { ok: true, value: maskSecrets(await readConfig()) };
			// Unsetting means "back to the schema default": the primary path
			// replaces the whole section, the fallback sends nulls so the Loader
			// entry deletes just those keys and the rest of the override stands.
			try {
				const current = await readConfig();
				const next = { ...current };
				for (const key of keys) Reflect.deleteProperty(next, key);
				await cctx.settings.replace(name, next);
				return { ok: true, value: maskSecrets(await readConfig()) };
			} catch (primaryError) {
				const patch = Object.fromEntries(keys.map((key) => [key, null]));
				const fallback = await writeConfigViaLoader({ cctx, ns: name, patch, readConfig });
				if (fallback.ok) {
					cctx.logger?.warn?.(`hackatime: settings write failed (${String(primaryError?.message ?? primaryError)}); cleared through the Loader entry instead`);
					return { ok: true, value: maskSecrets(fallback.value) };
				}
				return { ok: false, error: { code: "config-write-failed", message: `${String(primaryError?.message ?? primaryError)} — fallback also failed: ${fallback.error?.message ?? "unknown"}` } };
			}
		}
		if (endpoint === "hackatime.version") {
			// Ask npm for the latest tag so the card can show "update
			// available". Served over RPC so the browser stays out of the
			// network business and the host owns the actual update.
			try {
				const res = await fetch("https://registry.npmjs.org/dsh-hackatime/latest", { cache: "no-store" });
				const meta = res.ok ? await res.json() : null;
				const latest = typeof meta?.version === "string" ? meta.version : null;
				return {
					ok: true,
					value: {
						current: VERSION,
						latest,
						updateAvailable: Boolean(latest && compareVersions(latest, VERSION) > 0),
					},
				};
			} catch (error) {
				return { ok: false, error: { code: "version-check-failed", message: String(error?.message ?? error) } };
			}
		}
		if (endpoint === "hackatime.update") {
			// `dsh plugin --profile <p> update dsh-hackatime --latest -w` —
			// the documented self-update path, the same command dsh-pocket
			// runs. The browser cannot spawn a child, so the host owns it.
			// The profile name is validated strictly first: the spawn uses a
			// shell on Windows, where an unvalidated argument is a command
			// injection vector (`web & calc`), and even on POSIX a stray name
			// would target the wrong profile.
			const rawProfile = typeof payload?.profile === "string" ? payload.profile.trim() : "";
			if (rawProfile && !PROFILE_NAME_PATTERN.test(rawProfile)) {
				return { ok: false, error: { code: "bad-profile", message: "profile names may only contain letters, digits, dot, underscore and hyphen" } };
			}
			const profile = rawProfile || "web";
			try {
				const result = await runSelfUpdate(profile);
				return { ok: result.ok, value: { current: VERSION, output: result.output }, error: result.ok ? undefined : { code: "update-failed", message: result.output || result.error } };
			} catch (error) {
				return { ok: false, error: { code: "update-failed", message: String(error?.message ?? error) } };
			}
		}
		return { ok: false, error: { code: "bad-request", message: `Unknown endpoint: ${endpoint}` } };
	};
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
		/**
		 * What the card's "live" line shows: the session currently being timed.
		 * Updated from the event stream so the user can see tracking happening
		 * in real time, not just the counters.
		 */
		session: {
			/** Session id of the last activity, or null. */
			id: null,
			/** Project name resolved for the last heartbeat. */
			project: null,
			/** Last file/entity the plugin recorded. */
			entity: null,
			/** Model name from the most recent assistant turn, if AI reporting is on. */
			model: null,
			/** Epoch ms of the last activity in this session. */
			lastActivityAt: null,
		},
		/** Installed version, so the card can compare against npm's latest. */
		version: VERSION,
	};

	// The client half's settings card reads live status and reads/writes config
	// over this package-private channel (ctx.connection.rpc.call / .handle —
	// the same wiring dsh-pocket uses for its tab). Only status and config
	// values are exposed: counters, timestamps, and the user's own settings —
	// never heartbeat payloads.
	//
	// The card needs a way to persist edits, but the browser settings services
	// (`settingsScope`, `configForms`) are version-gated and absent on some
	// builds, which is what made the original tab fail to appear at all. The
	// host `settings` service is always present here, so config read/write is
	// served over RPC and the client needs no browser settings service at all.
	// This is exactly how dsh-pocket's tab works.
	const RPC_CHANNEL = "/dsh-hackatime";

	// Two independent inject paths, because the browser RPC changed transport:
	// dsh >= 0.1.5-alpha.1 carries it over the web server, older builds over
	// `connection.rpc.handle`. Cordis only exposes the services you inject, and
	// reading an uninjected `cctx.webServer` throws, so each path touches only
	// its own services. The web-server path wins when present; the other one
	// then stands down so the channel is never mounted twice.
	let rpcMounted = false;

	// --- primary: browser RPC over the web server (dsh >= 0.1.5-alpha.1) -----
	ctx.inject(["settings", "webServer"], (cctx) => {
		if (rpcMounted) return;
		if (typeof cctx.settings.register === "function") {
			try {
				cctx.settings.register(name, Config, { base: config });
			} catch (error) {
				ctx.logger?.warn?.(`hackatime: settings.register failed — ${error?.message ?? error}`);
			}
		}
		const readConfig = async () => {
			const described = cctx.settings.describe({ redactSecrets: false });
			const entry = Array.isArray(described) ? described.find((it) => it?.ns === name) : undefined;
			return entry?.value ?? entry?.base ?? config;
		};
		const rpcHandler = makeRpcHandler({ readConfig, cctx, status, config });

		// Bind the auth gate BEFORE the route is mounted, resolving the
		// connection service lazily — it is not in this scope's inject list
		// (hosts may run without a browser connection), and the gate must
		// still work when it IS present. `requestRejection` is called as a
		// method of the service, never extracted as a bare function.
		const resolveRejection = () => {
			const connection = cctx.connection ?? cctx.get?.("connection");
			return typeof connection?.requestRejection === "function"
				? (req) => connection.requestRejection(req)
				: undefined;
		};
		connectionResolve = resolveRejection;

		let dispose = null;
		try {
			const route = {
				kind: "prefix",
				path: RPC_CHANNEL,
				handler: makeWebRouteHandler(RPC_CHANNEL, rpcHandler, ctx.logger),
			};
			const registered = cctx.webServer.register(route);
			dispose = typeof registered === "function" ? registered : null;
			rpcMounted = true;
			ctx.effect(() => () => { try { dispose?.(); } catch { /* best effort */ } });
		} catch (error) {
			ctx.logger?.warn?.(`hackatime: webServer route failed — ${error?.message ?? error}`);
		}
	});

	// --- fallback: legacy Connection RPC (old dsh / headless / tests) --------
	ctx.inject(["settings", "connection"], (cctx) => {
		// The web-server path above is the working transport on modern builds;
		// stand down if it already mounted so the channel is not double-served.
		if (rpcMounted) return;

		if (typeof cctx.settings.register === "function") {
			try {
				cctx.settings.register(name, Config, { base: config });
			} catch (error) {
				ctx.logger?.warn?.(`hackatime: settings.register failed — ${error?.message ?? error}`);
			}
		}

		if (!cctx.connection?.rpc?.handle) {
			ctx.logger?.warn?.("hackatime: host Connection RPC unavailable — settings card will show limited status");
			return;
		}

		const readConfig = async () => {
			const described = cctx.settings.describe({ redactSecrets: false });
			const entry = Array.isArray(described) ? described.find((it) => it?.ns === name) : undefined;
			return entry?.value ?? entry?.base ?? config;
		};
		const rpcHandler = makeRpcHandler({ readConfig, cctx, status, config });

		try {
			const dispose = cctx.connection.rpc.handle(RPC_CHANNEL, rpcHandler);
			rpcMounted = true;
			ctx.effect(() => () => {
				try { dispose?.(); } catch { /* best-effort teardown */ }
			});
		} catch (error) {
			ctx.logger?.warn?.(`hackatime: status RPC unavailable — ${error?.message ?? error}`);
		}
	});

	// --- auto-update -------------------------------------------------------
	// When the switch is on, check npm once at startup and then every six
	// hours; a newer version installs itself through the same `dsh plugin
	// update` command the manual button runs. Deliberately quiet: a failed
	// check is not a tracking problem, so it only logs at debug level.
	// Runs regardless of which RPC transport mounted.
	if (unwrapVolatile(config.autoUpdate) !== false) {
		const resolvedDebug = unwrapVolatile(config.debug) === true;
		const checkAndUpdate = async () => {
			try {
				const res = await fetch("https://registry.npmjs.org/dsh-hackatime/latest", { cache: "no-store" });
				const meta = res.ok ? await res.json() : null;
				const latest = typeof meta?.version === "string" ? meta.version : null;
				if (!latest || compareVersions(latest, VERSION) <= 0) return;
				ctx.logger?.info?.(`hackatime: auto-updating to ${latest} (from ${VERSION})`);
				const result = await runSelfUpdate("web");
				if (result.ok) ctx.logger?.info?.(`hackatime: updated to ${latest} — restart the profile to load it`);
				else ctx.logger?.warn?.(`hackatime: auto-update to ${latest} failed — ${result.error ?? result.output}`);
			} catch (error) {
				if (resolvedDebug) ctx.logger?.warn?.(`hackatime: update check failed — ${error?.message ?? error}`);
			}
		};
		const timer = setTimeout(() => { void checkAndUpdate(); }, 90_000);
		const interval = setInterval(() => { void checkAndUpdate(); }, 6 * 60 * 60_000);
		ctx.effect(() => () => { clearTimeout(timer); clearInterval(interval); });
	}

	if (!unwrapVolatile(config.enabled)) {
		ctx.logger?.info?.("hackatime: disabled by config — not tracking");
		return;
	}

	/** Resolved config — api key/url may still come from ~/.wakatime.cfg.
	 *  Every field is declared `.volatile()` in the Config schema and dsh-cordis
	 *  hands those to apply() as references, not plain values. They are read
	 *  through getters (not snapshotted) so a key pasted in the settings card
	 *  takes effect on the next heartbeat without waiting for a re-activation. */
	const resolved = {
		get apiKey() { return unwrapVolatile(config.apiKey)?.trim() || undefined; },
		get apiUrl() { return unwrapVolatile(config.apiUrl)?.trim() || undefined; },
		get project() { return unwrapVolatile(config.project)?.trim() || undefined; },
		get machine() { return unwrapVolatile(config.machine)?.trim() || os.hostname(); },
		get rateLimit() { return Math.max(5, Math.min(600, unwrapVolatile(config.rateLimitSeconds) ?? DEFAULT_RATE_LIMIT_SECONDS)); },
		get sendEntityPath() { return unwrapVolatile(config.sendEntityPath) ?? true; },
		get sendAiUsage() { return unwrapVolatile(config.sendAiUsage) ?? true; },
		get debug() { return unwrapVolatile(config.debug) ?? false; },
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
				// Hackatime classifies agent-driven work under its own "ai
				// coding" category, distinct from "coding" (hand editing). The
				// server stores whatever category the client sends, and DSH is
				// precisely the case that belongs here.
				category: "ai coding",
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
		// Re-checked on every event rather than only at activation: flipping the
		// master switch is a volatile-only change, so the plugin is NOT
		// re-activated for it — the running loop has to honour the new value.
		if (unwrapVolatile(config.enabled) === false) return;
		try {
			const heartbeat = await buildHeartbeat(event);
			emit(heartbeat);
			// Mirror the recorded activity into the live-session view the card
			// shows, so the user can see exactly what is being tracked right now.
			status.session.id = event?.sessionId ?? status.session.id;
			status.session.entity = heartbeat.entity ?? status.session.entity;
			status.session.project = heartbeat.project ?? status.session.project;
			status.session.lastActivityAt = Date.now();
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

		// Remember which session the following activity belongs to, so the
		// card's live line can name it. Set before any record() call below.
		if (session?.id) status.session.id = session.id;

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
			if (model) status.session.model = model;
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
