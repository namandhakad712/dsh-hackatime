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

		/** Every seat this page can live in, most preferred first. */
		const SLOT_CANDIDATES = [
			// Top-level "Hackatime" tab in the Settings sidebar.
			{ name: "settings.section", options: { id: NAMESPACE, order: 90, label: () => "Hackatime" }, summary: false },
			// The bundle's own page on dsh >= 0.1.6.
			{ name: "plugins.bundle.config", options: { key: PACKAGE_NAME }, summary: true },
			// Settings → Plugins tab on dsh <= 0.1.5.
			{ name: "settings.plugin.item", options: { key: NAMESPACE }, summary: false },
		];

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
		 * Hard dependencies only. `settingsScope` is resolved LAZILY via
		 * `ctx.inject` below — declaring it here makes the whole client half
		 * block on "waiting for service: settingsScope" and breaks boot on a
		 * dsh that never provides it (this is exactly the 0.2.0 crash). Same
		 * for `connection`/`remote`: the RPC degrades to "unavailable" on
		 * their own when absent.
		 */
		exports.inject = ["slots"];

		function apply(ctx) {
			const rpcCall = (endpoint, payload, signal) => {
				const rpc = ctx?.connection?.rpc;
				if (!rpc?.call) return Promise.resolve({ ok: false, error: { code: "unavailable", message: "RPC unavailable" } });
				return rpc.call(RPC_CHANNEL, endpoint, payload, signal);
			};

			/**
			 * Mount the page in one seat. `scope` is passed in because it is
			 * resolved below (configForms on modern dsh, settingsScope on old).
			 */
			const registerPage = (scope, name, options, summary) => {
				const render = summary ? null : HackatimePage;
				if (render === null) return () => {};
				return ctx.slots.register({
					name,
					...options,
					// `reflect.get` needs no `inject` entry and returns
					// undefined when no locale plugin is loaded.
					inject: () => ({ scope, rpcCall, locale: ctx.reflect.get("locale") }),
				}, render);
			};

			/**
			 * Mount into every seat the host declares. Returns a disposer.
			 */
			const mountAll = (scoped, scope) => {
				const disposes = [];
				for (const slot of SLOT_CANDIDATES) {
					scoped.slots.inject(slot.name, () => {
						const dispose = registerPage(scope, slot.name, slot.options, slot.summary);
						disposes.push(dispose);
						return () => {
							const i = disposes.indexOf(dispose);
							if (i >= 0) disposes.splice(i, 1);
							dispose();
						};
					});
				}
				return () => disposes.splice(0).forEach((d) => { try { d(); } catch { /* best effort */ } });
			};

			/**
			 * Modern dsh (>= 0.1.7): `configForms` replaces the retired
			 * `settingsScope` service. `whileServed` holds the registration
			 * alive only while the host is actually serving the namespace, so
			 * a deployment that never composed this plugin's host half shows
			 * no trace of the page. This is exactly the shape
			 * dsh-client-ui-settings-web-search uses.
			 */
			ctx.inject(["configForms"], (scoped) => {
				const forms = scoped.configForms;
				if (!forms?.get || !forms?.whileServed) return;
				const form = forms.get(NAMESPACE);
				scoped.effect(() => forms.whileServed([NAMESPACE], () => mountAll(scoped, form)),
					`${NAMESPACE}: configForms settings page`);
			});

			/**
			 * Legacy dsh (<= 0.1.5): `settingsScope` is the binder. Declared
			 * lazily via `ctx.inject`, so on a modern build — where the
			 * service is retired — this callback simply never runs and boot
			 * is unaffected. Hard-injecting it makes the whole client half
			 * block on "waiting for service: settingsScope" and crashes boot
			 * (the 0.2.0 desktop crash). Same lazy shape dsh-context uses.
			 */
			ctx.inject(["settingsScope"], (scoped) => {
				const scope = scoped.settingsScope?.bind?.({ namespace: NAMESPACE }) ?? null;
				if (!scope) return;
				scoped.effect(() => mountAll(scoped, scope), `${NAMESPACE}: settingsScope settings page`);
			});
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
		 * The settings page. `view === "summary"` asks for a compact tile
		 * (we render nothing — the row already shows the plugin name).
		 */
		function HackatimePage({ scope, rpcCall, view }) {
			if (view === "summary" || !scope) return null;

			const snapshot = React.useSyncExternalStore(
				React.useCallback((listener) => scope.subscribe(listener), [scope]),
				() => scope.getSnapshot(),
			);
			const [drafts, setDrafts] = React.useState({});
			const [showSecret, setShowSecret] = React.useState(false);
			const [saving, setSaving] = React.useState(false);
			const [failed, setFailed] = React.useState("");
			const [status, setStatus] = React.useState(null);

			const stored = (key) => {
				const value = snapshot.value?.[key];
				if (typeof value === "boolean") return value;
				if (typeof value === "number") return value;
				return typeof value === "string" ? value : "";
			};
			const draft = (key) => drafts[key] ?? stored(key);
			const dirty = Object.keys(drafts).filter((key) => drafts[key] !== stored(key));
			const disabled = saving || snapshot.writable === false;

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
					for (const key of dirty) {
						const value = drafts[key];
						if (value === "" || value === undefined) await scope.unset(key);
						else await scope.set(key, value);
					}
					const after = scope.getSnapshot();
					const rejected = dirty.filter((key) => (after.value?.[key] ?? "") !== (drafts[key] ?? ""));
					setDrafts(Object.fromEntries(rejected.map((key) => [key, drafts[key]])));
					if (rejected.length > 0) setFailed("Some values were rejected by the host.");
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
