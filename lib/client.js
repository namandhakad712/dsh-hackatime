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
		const KEY_SETTINGS_URL = "https://hackatime.hackclub.com/settings";

		const FIELDS = [
			{ key: "apiKey", label: "Hackatime API key", kind: "secret",
				help: `Get it from ${KEY_SETTINGS_URL}. Leave blank to read ~/.wakatime.cfg.` },
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
		];

		/**
		 * Hard dependencies only — `slots` is present on every browser build.
		 * The browser settings services (`settingsScope` on dsh <= 0.1.5,
		 * `configForms` on >= 0.1.7) are version-gated: `settingsScope` was
		 * deleted in core 0.1.7, and neither is guaranteed to exist. Gating the
		 * tab's registration on either service is what made the original tab
		 * silently never appear — the lazy callback simply never fired.
		 *
		 * So the page owns no config scope at all. It reads and writes config
		 * through the package RPC channel (`hackatime.config.get` / `.set`),
		 * which the host half always serves from the real `settings` service.
		 * This is exactly how dsh-pocket's settings tab works, and it renders on
		 * every build. `connection` is resolved lazily so a host without it
		 * still activates and merely shows "unavailable".
		 */
		exports.inject = ["slots"];

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
					inject: () => ({ rpcCall }),
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
					inject: () => ({ rpcCall }),
				}, HackatimePage);
			}), `${NAMESPACE}: bundle config page`);

			ctx.effect(() => ctx.slots.inject("settings.plugin.item", () => {
				return ctx.slots.register({
					name: "settings.plugin.item",
					key: NAMESPACE,
					inject: () => ({ rpcCall }),
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
		function HackatimePage({ rpcCall }) {
			const [config, setConfig] = React.useState(null);
			const [drafts, setDrafts] = React.useState({});
			const [showSecret, setShowSecret] = React.useState(false);
			const [saving, setSaving] = React.useState(false);
			const [failed, setFailed] = React.useState("");
			const [status, setStatus] = React.useState(null);

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

			// Poll the host for live status. The RPC resolves even while the
			// master switch is off (the handler is registered unconditionally).
			React.useEffect(() => {
				let alive = true;
				const load = async () => {
					try {
						const res = await rpcCall(ENDPOINT_STATUS, {});
						if (alive) setStatus(res?.ok ? res.value : null);
					} catch {
						if (alive) setStatus(null);
					}
				};
				void load();
				const id = setInterval(load, 5000);
				return () => { alive = false; clearInterval(id); };
			}, [rpcCall]);

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
					placeholder: "from ~/.wakatime.cfg", disabled, style: { ...inputStyle, flex: "1" },
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

			const configPanel = React.createElement("section", { style: panelStyle },
				React.createElement("h3", { style: headingStyle }, "Settings"),
				// The master switch sits outside FIELDS so it always renders first.
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
				FIELDS.map(fieldRow),
			);

			// --- guide ---------------------------------------------------------

			const guidePanel = React.createElement("section", { style: panelStyle },
				React.createElement("h3", { style: headingStyle }, "Getting started"),
				React.createElement("ol", { style: { margin: 0, paddingLeft: "20px", display: "grid", gap: "8px", fontSize: "13px", lineHeight: 1.6 } },
					React.createElement("li", null,
						React.createElement("a", { href: KEY_SETTINGS_URL, target: "_blank", rel: "noreferrer", style: linkStyle },
							"Create a Hackatime account", " ↗"),
						" — free for Hack Club, and it counts toward your leaderboard.",
					),
					React.createElement("li", null,
						"Copy your API key from ",
						React.createElement("a", { href: KEY_SETTINGS_URL, target: "_blank", rel: "noreferrer", style: linkStyle }, "Settings", " ↗"),
						" and paste it above, or put it in ",
						React.createElement("code", { style: codeStyle }, "~/.wakatime.cfg"),
						".",
					),
					React.createElement("li", null,
						"Work normally — every message you send and file you edit becomes coding time on your Hackatime dashboard.",
					),
				),
			);

			return React.createElement("div", { style: { display: "grid", gap: "18px", maxWidth: "680px" } },
				statusPanel,
				configPanel,
				guidePanel,
				failed && React.createElement("div", {
					style: { fontSize: "12.5px", color: "var(--dsw-alias-state-error-primary, #dc2626)" },
				}, failed),
				React.createElement("button", {
					type: "button", onClick: save,
					disabled: disabled || dirty.length === 0,
					style: primaryButtonStyle(disabled || dirty.length === 0),
				}, saving ? "Saving…" : `Save${dirty.length > 0 ? ` (${dirty.length})` : ""}`),
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
