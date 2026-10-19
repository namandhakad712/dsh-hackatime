/**
 * dsh-hackatime — client settings page.
 *
 * Renders as a first-class tab in the Settings sidebar (the same
 * `settings.section` seat dsh-pocket and dsh-vision-router use) plus the
 * bundle's own config page, and reads live tracking status from the host half
 * over the package RPC channel.
 */

window.__ModuleLoader__.load({
	id: "dsh-hackatime",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		"use strict";
		Object.defineProperty(exports, "__esModule", { value: true });
		exports.apply = apply;
		exports.inject = void 0;

		const React = require("react");

		/** Must match the host half's `name`. */
		const NAMESPACE = "hackatime";
		/** This bundle's package name — keyed slots use it. */
		const PACKAGE_NAME = "dsh-hackatime";
		/** Package-private RPC channel; must match the host half. */
		const RPC_CHANNEL = "/dsh-hackatime";
		const ENDPOINT_STATUS = "hackatime.status";
		const DASHBOARD_URL = "https://hackatime.hackclub.com";
		const KEY_SETTINGS_URL = "https://hackatime.hackclub.com/api-key";

		// The one field a brand-new user must fill in. It gets the hero
		// treatment: its own panel, a numbered cue, and nothing else in it, so
		// a student opening this tab sees exactly one thing to do.
		const SETUP_FIELDS = [
			{ key: "apiKey", label: "Hackatime API key", kind: "secret",
				help: `Get one at ${KEY_SETTINGS_URL}. Leave blank to keep using ~/.wakatime.cfg. The stored key is never sent back here.` },
		];

		// Everything else is power-user plumbing: server URL, overrides, rate
		// limit, privacy toggles. It lives behind a disclosure so the default
		// view stays one job — paste a key, press Save.
		const ADVANCED_FIELDS = [
			{ key: "apiUrl", label: "API base URL", kind: "text",
				help: "Defaults to https://hackatime.hackclub.com/api/hackatime/v1. Point this at a self-hosted server if you run one." },
			{ key: "project", label: "Project name override", kind: "text",
				help: "Blank = workspace folder name (or .wakatime-project file)." },
			{ key: "machine", label: "Machine name override", kind: "text",
				help: "Blank = this computer's hostname." },
			{ key: "rateLimitSeconds", label: "Rate limit (seconds)", kind: "number",
				help: "Minimum gap between two heartbeats for the same file. WakaTime's default is 30." },
			{ key: "sendEntityPath", label: "Send file paths", kind: "boolean",
				help: "Off replaces file paths with the project name. Turn off for privacy." },
			{ key: "sendAiUsage", label: "Report AI token usage", kind: "boolean",
				help: "Adds ai_model, ai_input_tokens and ai_output_tokens to heartbeats." },
			{ key: "debug", label: "Debug logging", kind: "boolean",
				help: "Log every heartbeat to the host console." },
			{ key: "autoUpdate", label: "Automatically update", kind: "boolean",
				help: "Install the newest published dsh-hackatime on its own. Off means you press the update button yourself." },
		];

		/**
		 * Hard dependencies. `slots` is present on every browser build;
		 * `connection` is the browser RPC carrier that `rpcCall` talks through.
		 * Cordis only exposes the services you list here — omitting
		 * `connection` leaves `ctx.connection` undefined, every call settles as
		 * "unavailable", and the card renders with every field disabled. That
		 * is exactly how dsh-pocket declares it, and it is present on every web
		 * build.
		 */
		exports.inject = ["slots", "connection"];

		function apply(ctx) {
			/**
			 * Package-private RPC to our own host half. `connection` is optional:
			 * on a host that never provides it, calls settle as "unavailable" and
			 * the card still renders with a placeholder.
			 */
			const rpcCall = (endpoint, payload) => {
				const connection = ctx.connection ?? ctx.get?.("connection");
				const rpc = connection?.rpc;
				if (!rpc?.call) return Promise.resolve({ ok: false, error: { code: "unavailable", message: "RPC unavailable" } });
				return Promise.resolve(rpc.call(RPC_CHANNEL, endpoint, payload));
			};

			/**
			 * The workspace of the window the user is actually looking at right
			 * now — the session held by the main view (dsh marks it with
			 * `retainedBy.mainView > 0`, the same test the workspace UI uses).
			 * `sessions` is resolved lazily so the card still renders on a host
			 * that does not expose the service. Returns null when no window is
			 * foreground, so the host can fall back to the last session it saw.
			 */
			const activeCwd = () => {
				try {
					const sessions = ctx.get?.("sessions");
					const byId = sessions?.list?.getSnapshot?.()?.byId;
					if (!byId) return null;
					const main = Object.values(byId).find((row) => (row?.retainedBy?.mainView ?? 0) > 0);
					const cwd = main?.cwd;
					return typeof cwd === "string" && cwd ? cwd : null;
				} catch {
					return null;
				}
			};

			/**
			 * Register the page unconditionally, the moment this client half
			 * activates — not behind any settings-service callback. dsh-pocket
			 * registers `settings.section` exactly this way, which is why its tab
			 * is always present; gating on `configForms`/`settingsScope` is why
			 * ours was not.
			 */
			ctx.effect(() => ctx.slots.inject("settings.section", () => {
				return ctx.slots.register({
					name: "settings.section",
					id: NAMESPACE,
					order: 90,
					label: () => "Hackatime",
					inject: () => ({ rpcCall, activeCwd }),
				}, HackatimePage);
			}), `${NAMESPACE}: settings section`);

			/**
			 * The bundle config page (dsh >= 0.1.6) and the legacy plugins-tab row
			 * (dsh <= 0.1.5). Same unconditional registration.
			 */
			ctx.effect(() => ctx.slots.inject("plugins.bundle.config", () => {
				return ctx.slots.register({
					name: "plugins.bundle.config",
					key: PACKAGE_NAME,
					summary: true,
					inject: () => ({ rpcCall, activeCwd }),
				}, HackatimePage);
			}), `${NAMESPACE}: bundle config page`);

			ctx.effect(() => ctx.slots.inject("settings.plugin.item", () => {
				return ctx.slots.register({
					name: "settings.plugin.item",
					key: NAMESPACE,
					inject: () => ({ rpcCall, activeCwd }),
				}, HackatimePage);
			}), `${NAMESPACE}: plugin settings item`);
		}

		// --- view helpers ------------------------------------------------------

		/** Relative time like "12s ago" / "3m ago", or "never". */
		function relativeTime(ms) {
			if (!ms) return "never";
			const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
			if (seconds < 5) return "just now";
			if (seconds < 60) return `${seconds}s ago`;
			const minutes = Math.round(seconds / 60);
			if (minutes < 60) return `${minutes}m ago`;
			const hours = Math.round(minutes / 60);
			if (hours < 24) return `${hours}h ago`;
			return `${Math.round(hours / 24)}d ago`;
		}

		/** Last path segment, so a long workspace file path stays readable. */
		function pathBasename(p) {
			const s = String(p ?? "");
			const slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
			return slash < 0 ? s : s.slice(slash + 1);
		}

		/** Small status pill with a colored dot. */
		function StatusPill({ tone, label }) {
			const color = {
				connected: "var(--dsw-alias-state-success-primary, #16a34a)",
				warn: "var(--dsw-alias-state-warn-primary, #b45309)",
				error: "var(--dsw-alias-state-error-primary, #dc2626)",
				idle: "var(--dsw-alias-state-idle-primary, #8a8f98)",
			}[tone] || "var(--dsw-alias-state-idle-primary, #8a8f98)";
			return React.createElement("span", {
				style: {
					display: "inline-flex", alignItems: "center", gap: "7px",
					fontSize: "12.5px", fontWeight: 500, lineHeight: 1,
					padding: "6px 11px", borderRadius: "999px",
					background: "var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.03))",
					border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08))",
					color: "var(--dsw-alias-label-primary, inherit)",
					whiteSpace: "nowrap",
				},
			},
				React.createElement("span", { style: { width: "7px", height: "7px", borderRadius: "50%", background: color, flex: "0 0 auto" } }),
				label,
			);
		}

		// --- the page ----------------------------------------------------------

		/**
		 * The settings page. Loads its own config from the host half over the
		 * package RPC (`hackatime.config.get`) and writes drafts back with
		 * `hackatime.config.set`. Using RPC rather than a browser config scope
		 * is what makes the page work on every dsh build — the scope services
		 * are version-gated, the RPC channel is not.
		 */
		function HackatimePage({ rpcCall, activeCwd }) {
			const [config, setConfig] = React.useState(null);
			const [drafts, setDrafts] = React.useState({});
			const [showSecret, setShowSecret] = React.useState(false);
			const [saving, setSaving] = React.useState(false);
			const [failed, setFailed] = React.useState("");
			const [status, setStatus] = React.useState(null);
			const [version, setVersion] = React.useState(null);
			const [updating, setUpdating] = React.useState(false);
			// Advanced settings start closed: the whole job for a new user is
			// "paste your key and press Save". Everything else is power-user
			// plumbing and should never be the first thing they see.
			const [showAdvanced, setShowAdvanced] = React.useState(false);

			// Load config once. The host applies schema defaults server-side, so
			// `config` arrives fully resolved even when the user has set nothing.
			React.useEffect(() => {
				let alive = true;
				const load = async () => {
					const res = await rpcCall("hackatime.config.get", {});
					if (!alive) return;
					if (res?.ok) setConfig(res.value ?? {});
					else setFailed(res?.error?.message ?? "Could not load settings");
				};
				void load();
				return () => { alive = false; };
			}, [rpcCall]);

			const stored = (key) => {
				const value = config?.[key];
				if (typeof value === "boolean") return value;
				if (typeof value === "number") return value;
				return typeof value === "string" ? value : "";
			};
			const draft = (key) => drafts[key] ?? stored(key);
			const dirty = Object.keys(drafts).filter((key) => drafts[key] !== stored(key));
			const disabled = saving || config === null;

			const enabled = stored("enabled") !== false;
			const sendAiUsage = stored("sendAiUsage") !== false;

			// Poll the host for live status. The RPC resolves even while the
			// master switch is off (the handler is registered unconditionally).
			// The request carries the foreground window's workspace so the host
			// can name the project actually being tracked right now.
			React.useEffect(() => {
				let alive = true;
				const load = async () => {
					try {
						const res = await rpcCall(ENDPOINT_STATUS, { activeCwd: activeCwd?.() ?? null });
						if (alive) setStatus(res?.ok ? res.value : null);
					} catch {
						if (alive) setStatus(null);
					}
				};
				void load();
				const id = setInterval(load, 3000);
				return () => { alive = false; clearInterval(id); };
			}, [rpcCall]);

			// Check npm for a newer build on open and every 30 minutes. The host
			// does its own check too (and can install it), this just decides
			// whether to show the badge and the manual button.
			React.useEffect(() => {
				let alive = true;
				const check = async () => {
					try {
						const res = await rpcCall("hackatime.version", {});
						if (alive && res?.ok) setVersion(res.value);
					} catch {
						/* offline is not an error worth showing */
					}
				};
				void check();
				const id = setInterval(check, 30 * 60_000);
				return () => { alive = false; clearInterval(id); };
			}, [rpcCall]);

			const runUpdate = async () => {
				setUpdating(true);
				try {
					const res = await rpcCall("hackatime.update", {});
					if (res?.ok) {
						setVersion((v) => (v ? { ...v, updateAvailable: false } : v));
						setFailed("");
					} else {
						setFailed(res?.error?.message ?? "Update failed — check the host log.");
					}
				} catch (error) {
					setFailed(String(error?.message ?? error));
				} finally {
					setUpdating(false);
				}
			};

			const save = async () => {
				setSaving(true);
				setFailed("");
				try {
					// Send only the changed fields; the host merges them into
					// the namespace and returns the fully resolved result.
					const patch = Object.fromEntries(dirty.map((key) => [key, drafts[key]]));
					const res = await rpcCall("hackatime.config.set", patch);
					if (!res?.ok) {
						setFailed(res?.error?.message ?? "The host rejected the change");
						return;
					}
					setConfig(res.value ?? {});
					setDrafts({});
				} catch (error) {
					setFailed(String(error?.message ?? error));
				} finally {
					setSaving(false);
				}
			};

			const setField = (key, value) => setDrafts((s) => ({ ...s, [key]: value }));

			// --- status panel --------------------------------------------------

			const hasKey = String(draft("apiKey") ?? "").trim().length > 0 || Boolean(status?.hasApiKey);
			const tone = !enabled
				? "idle"
				: !hasKey
					? "warn"
					: status?.lastErrorAt && (!status?.lastSubmitAt || status.lastErrorAt > status.lastSubmitAt)
						? "error"
						: status?.lastSubmitAt ? "connected" : "idle";
			const stateLabel = {
				idle: enabled ? "Waiting for activity" : "Paused",
				warn: "No API key",
				error: "Connection error",
				connected: "Connected",
			}[tone];

			const statRow = (label, value) => React.createElement("div", {
				style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "12px" },
			},
				React.createElement("span", { style: { color: "var(--dsw-alias-label-secondary, rgba(0,0,0,0.55))" } }, label),
				React.createElement("span", { style: { fontVariantNumeric: "tabular-nums", textAlign: "right" } }, value),
			);

			const statusPanel = React.createElement("section", { style: panelStyle },
				React.createElement("h3", { style: headingStyle }, "Connection"),
				React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "14px" } },
					React.createElement(StatusPill, { tone, label: stateLabel }),
					React.createElement("a", {
						href: DASHBOARD_URL, target: "_blank", rel: "noreferrer", style: linkStyle,
					}, "Open Hackatime dashboard ↗"),
				),
				statRow("Heartbeats sent", String(status?.submitted ?? 0)),
				statRow("Last heartbeat sent", relativeTime(status?.lastHeartbeatAt)),
				statRow("Last delivered to server", relativeTime(status?.lastSubmitAt)),
				statRow("Waiting to send", String(status?.pending ?? 0)),
				statRow("Server", status?.apiUrl || "not resolved yet"),
				status?.lastError && React.createElement("div", {
					style: { marginTop: "10px", fontSize: "12px", lineHeight: 1.5, color: "var(--dsw-alias-state-error-primary, #dc2626)" },
				}, `Last error: ${status.lastError}`),
				!hasKey && React.createElement("div", {
					style: { marginTop: "10px", fontSize: "12px", lineHeight: 1.5, color: "var(--dsw-alias-state-warn-primary, #b45309)" },
				}, "No API key set — tracking stays paused until you add one below or in ~/.wakatime.cfg."),
			);

			// --- live session --------------------------------------------------

			// What the plugin is timing right now. `activeProject` is resolved
			// host-side from the foreground window's workspace (the session the
			// user is actually looking at), so this answers "is it tracking the
			// thing I am working on" rather than "did some session emit last".
			const sess = status?.session ?? {};
			const live = Boolean(sess.lastActivityAt) && Date.now() - sess.lastActivityAt < 120_000;
			const shownProject = status?.activeProject || sess.project || null;
			const livePanel = React.createElement("section", { style: panelStyle },
				React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" } },
					React.createElement("h3", { style: headingStyle }, "Currently tracking"),
					React.createElement(StatusPill, { tone: live ? "connected" : "idle", label: live ? "Live" : "Idle" }),
				),
				React.createElement("div", {
					style: {
						display: "flex", alignItems: "center", gap: "10px",
						padding: "10px 12px", borderRadius: "10px",
						background: "var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.03))",
						border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06))",
					},
				},
					React.createElement("span", {
						style: {
							width: "8px", height: "8px", borderRadius: "50%", flex: "0 0 auto",
							background: live
								? "var(--dsw-alias-state-success-primary, #16a34a)"
								: "var(--dsw-alias-state-idle-primary, #8a8f98)",
						},
					}),
					React.createElement("div", { style: { minWidth: 0, flex: "1" } },
						React.createElement("div", { style: { fontSize: "14px", fontWeight: 600, lineHeight: 1.3 } },
							shownProject || "No project yet"),
						React.createElement("div", {
							style: {
								fontSize: "11.5px", lineHeight: 1.4, marginTop: "2px",
								color: "var(--dsw-alias-label-secondary, rgba(0,0,0,0.55))",
								overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
							},
						}, status?.activeCwd || "the window you are working in"),
					),
				),
				statRow("File", sess.entity ? pathBasename(sess.entity) : "—"),
				statRow("Model", sess.model || (sendAiUsage ? "—" : "AI reporting off")),
				statRow("Last activity", relativeTime(sess.lastActivityAt)),
				React.createElement("div", {
					style: { fontSize: "11.5px", lineHeight: 1.45, color: "var(--dsw-alias-label-secondary, rgba(0,0,0,0.55))" },
				}, live
					? "Heartbeats are being recorded for this project."
					: "No activity in the last two minutes — nothing is being timed right now."),
			);

			// --- config rows ---------------------------------------------------

			const toggleRow = (field) => {
				const value = Boolean(draft(field.key));
				return row(field, React.createElement("button", {
					type: "button",
					role: "switch",
					"aria-checked": value,
					disabled,
					onClick: () => setField(field.key, !value),
					style: switchTrackStyle(value, disabled),
				}, React.createElement("span", { style: switchKnobStyle(value) })));
			};

			const inputRow = (field) => row(field, React.createElement("input", {
				type: "text", value: String(draft(field.key) ?? ""), disabled, style: inputStyle,
				spellCheck: false, autoComplete: "off",
				onChange: (e) => setField(field.key, e.target.value),
			}));

			const numberRow = (field) => row(field, React.createElement("input", {
				type: "number", min: "5", max: "600", value: String(draft(field.key) ?? ""),
				disabled, style: { ...inputStyle, maxWidth: "96px", textAlign: "right" },
				onChange: (e) => setField(field.key, Number(e.target.value)),
			}));

			const secretRow = (field) => row(field, React.createElement("div", { style: { display: "flex", gap: "6px", maxWidth: "280px", width: "100%" } },
				React.createElement("input", {
					type: showSecret ? "text" : "password", value: String(draft(field.key) ?? ""),
					// The key is write-only on the read path, so the stored one
					// never appears here. Tell the user what an empty field
					// means instead of looking unsaved.
					placeholder: hasKey ? "a key is already saved — paste a new one to replace it" : "paste your key here",
					disabled, style: { ...inputStyle, flex: "1" },
					spellCheck: false, autoComplete: "off",
					onChange: (e) => setField(field.key, e.target.value),
				}),
				React.createElement("button", {
					type: "button", disabled, onClick: () => setShowSecret((s) => !s),
					style: { ...ghostButtonStyle, height: "34px" },
				}, showSecret ? "Hide" : "Show"),
			));

			const fieldRow = (field) => {
				if (field.kind === "boolean") return toggleRow(field);
				if (field.kind === "number") return numberRow(field);
				if (field.kind === "secret") return secretRow(field);
				return inputRow(field);
			};

			// --- setup hero ----------------------------------------------------
			// The first thing a new user sees: the API key and nothing else.

			// Numbered visual onboarding, shown only while no key is present —
			// the three steps a student needs, and nothing else. Once a key
			// exists this collapses away so the card stays out of the way.
			const stepRow = (n, text) => React.createElement("div", { style: {
				display: "grid", gridTemplateColumns: "22px 1fr", gap: "10px", alignItems: "start",
				fontSize: "12.5px", lineHeight: 1.5,
			} },
				React.createElement("span", {
					style: {
						width: "20px", height: "20px", borderRadius: "50%",
						display: "inline-flex", alignItems: "center", justifyContent: "center",
						fontSize: "11px", fontWeight: 700, lineHeight: 1,
						background: "var(--dsw-alias-primary-bg, rgba(99,102,241,0.10))",
						color: "var(--dsw-alias-primary-primary, #6366f1)",
					},
				}, String(n)),
				React.createElement("span", null, text),
			);

			const saveButton = React.createElement("button", {
				type: "button", onClick: save,
				disabled: disabled || dirty.length === 0,
				style: { ...primaryButtonStyle(disabled || dirty.length === 0), justifySelf: "start" },
			}, saving ? "Saving…" : dirty.length > 0 ? `Save (${dirty.length})` : "Saved");

			const setupPanel = React.createElement("section", { style: panelStyle },
				React.createElement("div", null,
					React.createElement("h3", { style: { ...headingStyle, fontSize: "15px" } }, "Connect your Hackatime account"),
					React.createElement("p", {
						style: { margin: "4px 0 0", fontSize: "12.5px", lineHeight: 1.55, color: "var(--dsw-alias-label-secondary, rgba(0,0,0,0.55))" },
					}, "Paste your API key and press Save — that is the whole setup. Everything else below is optional."),
				),
				!hasKey && React.createElement("div", { style: { display: "grid", gap: "8px" } },
					stepRow(1, React.createElement("span", null,
						React.createElement("a", { href: KEY_SETTINGS_URL, target: "_blank", rel: "noreferrer", style: linkStyle }, "Create a free Hackatime account", " ↗"))),
					stepRow(2, React.createElement("span", null,
						"Copy your API key from ",
						React.createElement("a", { href: KEY_SETTINGS_URL, target: "_blank", rel: "noreferrer", style: linkStyle }, "Settings", " ↗"))),
					stepRow(3, "Paste it below and press Save."),
				),
				SETUP_FIELDS.map(fieldRow),
				saveButton,
				React.createElement("div", {
					style: {
						display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap",
						fontSize: "12px", lineHeight: 1.5,
						color: "var(--dsw-alias-label-secondary, rgba(0,0,0,0.55))",
					},
				},
					React.createElement("span", null, "No account yet?"),
					React.createElement("a", { href: KEY_SETTINGS_URL, target: "_blank", rel: "noreferrer", style: linkStyle },
						"Create one free", " ↗"),
				),
			);

			// --- advanced settings ---------------------------------------------
			// Collapsed by default. The disclosure is a real <button> so it is
			// keyboard-operable, and it carries the master switch plus every
			// override/privacy field.

			const advancedToggle = React.createElement("button", {
				type: "button",
				onClick: () => setShowAdvanced((v) => !v),
				"aria-expanded": showAdvanced,
				style: {
					...panelStyle, cursor: "pointer", textAlign: "left",
					display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px",
					font: "inherit",
				},
			},
				React.createElement("span", { style: { fontSize: "13px", fontWeight: 600 } }, "Advanced settings"),
				React.createElement("span", {
					style: { fontSize: "11.5px", color: "var(--dsw-alias-label-secondary, rgba(0,0,0,0.55))" },
				}, showAdvanced ? "Hide" : "Show"),
			);

			const advancedPanel = showAdvanced && React.createElement("section", { style: panelStyle },
				// The master switch sits outside ADVANCED_FIELDS so it always
				// renders first when the section is opened.
				row(
					{ key: "enabled", label: "Track coding time", help: "Send WakaTime-style heartbeats to Hackatime while you work in DeepSeek Harness." },
					React.createElement("button", {
						type: "button",
						role: "switch",
						"aria-checked": enabled,
						disabled,
						onClick: () => setField("enabled", !enabled),
						style: switchTrackStyle(enabled, disabled),
					}, React.createElement("span", { style: switchKnobStyle(enabled) })),
				),
				ADVANCED_FIELDS.map(fieldRow),
				// A second Save here so a user who expanded this section never
				// has to scroll back up to the key panel to commit a change.
				saveButton,
			);

			// --- guide ---------------------------------------------------------

			const guidePanel = React.createElement("section", { style: panelStyle },
				React.createElement("h3", { style: headingStyle }, "How it works"),
				React.createElement("div", {
					style: { fontSize: "12.5px", lineHeight: 1.6, color: "var(--dsw-alias-label-secondary, rgba(0,0,0,0.55))" },
				},
					"DeepSeek Harness sends a heartbeat to Hackatime every time you send a message or edit a file, and Hackatime sums them into coding time for the project shown in ",
					React.createElement("b", { style: { color: "var(--dsw-alias-label-primary, inherit)" } }, "Currently tracking"),
					". Check it on your ",
					React.createElement("a", { href: DASHBOARD_URL, target: "_blank", rel: "noreferrer", style: linkStyle }, "dashboard", " ↗"),
					" — time appears within a minute.",
				),
				React.createElement("div", {
					style: {
						padding: "12px 14px", borderRadius: "10px", fontSize: "12.5px", lineHeight: 1.6,
						background: "var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.03))",
						border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06))",
					},
				},
					React.createElement("div", { style: { fontWeight: 600, marginBottom: "6px" } }, "What counts"),
					React.createElement("div", null, "• A message you send — you are at the keyboard."),
					React.createElement("div", null, "• A tool the agent runs on a file — edits, reads, builds."),
					React.createElement("div", null, "• A finished model turn, tagged with the model and token counts when AI reporting is on."),
					React.createElement("div", { style: { marginTop: "6px", color: "var(--dsw-alias-label-secondary, rgba(0,0,0,0.55))" } },
						"Time is summed server-side from consecutive heartbeats, so short gaps are free. Nothing is sent while the master switch is off."),
				),
			);

			return React.createElement("div", { style: { display: "grid", gap: "18px", maxWidth: "680px" } },
				livePanel,
				setupPanel,
				React.createElement("div", { style: { display: "grid", gap: "8px" } },
					advancedToggle,
					advancedPanel,
				),
				version?.updateAvailable && React.createElement("div", {
					style: {
						display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap",
						padding: "12px 14px", borderRadius: "12px",
						background: "var(--dsw-alias-state-warn-bg, rgba(180,83,9,0.08))",
						border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08))",
					},
				},
					React.createElement("div", { style: { fontSize: "12.5px", lineHeight: 1.5 } },
						React.createElement("b", null, `dsh-hackatime ${version.latest} is available`),
						` — you are on ${version.current}. ${draft("autoUpdate") === false ? "Auto-update is off." : ""}`),
					React.createElement("button", {
						type: "button", onClick: runUpdate, disabled: updating,
						style: ghostButtonStyle,
					}, updating ? "Updating…" : "Update now"),
				),
				statusPanel,
				guidePanel,
				failed && React.createElement("div", {
					style: { fontSize: "12.5px", color: "var(--dsw-alias-state-error-primary, #dc2626)" },
				}, failed),
			);
		}

		// --- styles ------------------------------------------------------------

		const panelStyle = {
			background: "var(--dsw-alias-bg-layer-1, transparent)",
			border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08))",
			borderRadius: "12px",
			padding: "16px",
			display: "grid",
			gap: "10px",
		};

		const headingStyle = {
			margin: 0, fontSize: "13px", fontWeight: 600,
			color: "var(--dsw-alias-label-primary, inherit)",
		};

		const row = (field, control) => React.createElement("div", {
			key: field.key,
			style: {
				display: "flex", justifyContent: "space-between", alignItems: "center",
				gap: "16px", padding: "8px 0",
				borderTop: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06))",
			},
		},
			React.createElement("div", { style: { minWidth: "0", flex: "1" } },
				React.createElement("div", { style: { fontSize: "13px", fontWeight: 500, marginBottom: "2px" } }, field.label),
				React.createElement("div", {
					style: { fontSize: "11.5px", lineHeight: 1.45, color: "var(--dsw-alias-label-secondary, rgba(0,0,0,0.55))" },
				}, field.help),
			),
			React.createElement("div", { style: { flex: "0 0 auto", display: "flex", alignItems: "center" } }, control),
		);

		const inputStyle = {
			width: "100%", boxSizing: "border-box", padding: "6px 10px",
			border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.14))",
			borderRadius: "8px",
			background: "var(--dsw-alias-bg-layer-2, transparent)",
			color: "var(--dsw-alias-label-primary, inherit)", fontSize: "13px",
			height: "34px",
		};

		const linkStyle = {
			color: "var(--dsw-alias-brand-primary, #4f6ef7)",
			textDecoration: "none",
			fontWeight: 500,
		};

		const codeStyle = {
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
			fontSize: "12px",
			padding: "1px 5px",
			borderRadius: "5px",
			background: "var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.05))",
		};

		const switchTrackStyle = (on, disabled) => ({
			position: "relative",
			width: "40px", height: "22px", borderRadius: "999px",
			border: "none", cursor: disabled ? "default" : "pointer",
			padding: 0, flex: "0 0 auto",
			background: on
				? "var(--dsw-alias-brand-primary, #4f6ef7)"
				: "var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.12))",
			opacity: disabled ? 0.5 : 1,
			transition: "background 0.15s ease",
		});

		const switchKnobStyle = (on) => ({
			position: "absolute",
			top: "2px", left: on ? "20px" : "2px",
			width: "18px", height: "18px", borderRadius: "50%",
			background: "#fff",
			boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
			transition: "left 0.15s ease",
		});

		const ghostButtonStyle = {
			font: "inherit", cursor: "pointer",
			border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.14))",
			background: "var(--dsw-alias-bg-layer-1, transparent)",
			color: "var(--dsw-alias-label-primary, inherit)",
			padding: "0 12px", borderRadius: "8px", fontSize: "12.5px",
		};

		const primaryButtonStyle = (isDisabled) => ({
			font: "inherit", cursor: isDisabled ? "default" : "pointer",
			border: "none",
			background: "var(--dsw-alias-brand-primary, #4f6ef7)",
			color: "var(--dsw-alias-label-primary-foreground, #fff)",
			height: "36px", padding: "0 18px", borderRadius: "999px",
			fontSize: "13px", fontWeight: 500,
			opacity: isDisabled ? 0.45 : 1,
			justifySelf: "start",
		});

		return module.exports;
	},
});
