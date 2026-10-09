/**
 * dsh-hackatime — client settings card.
 *
 * Rendered in the Plugins page's bundle-config seat (dsh >= 0.1.6) or the
 * Settings → Plugins tab (dsh <= 0.1.5). Reads and writes the same `hackatime`
 * settings namespace the host half registered, so the card and the profile's
 * cordis.patch.yml are always two views of one config.
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
		/** This bundle's package name — the dsh >= 0.1.6 config slot is keyed by it. */
		const PACKAGE_NAME = "dsh-hackatime";

		/**
		 * Every slot this card knows how to live in, most preferred first.
		 *
		 * dsh moved this seat between releases (0.1.5 dispatched
		 * `settings.plugin.item`; 0.1.6 moved plugin config to the sidebar
		 * Plugins page), so naming both keeps the card visible on either.
		 * `ctx.slots.inject` waits for a declaration instead of throwing, so
		 * naming a slot a host has never heard of costs nothing.
		 */
		const SLOT_CANDIDATES = [
			{ name: "plugins.bundle.config", options: { key: PACKAGE_NAME } },
			{ name: "settings.plugin.item", options: { key: NAMESPACE } },
		];

		const FIELDS = [
			{ key: "enabled", label: "Track coding time", kind: "boolean",
				help: "Send WakaTime-style heartbeats to Hackatime while you work in DeepSeek Harness." },
			{ key: "apiKey", label: "Hackatime API key", kind: "secret",
				help: "Get it from https://hackatime.hackclub.com/settings. Leave blank to read ~/.wakatime.cfg." },
			{ key: "apiUrl", label: "API base URL", kind: "text",
				help: "Defaults to https://hackatime.hackclub.com/api/hackatime/v1. Point this at a self-hosted server if you run one." },
			{ key: "project", label: "Project name override", kind: "text",
				help: "Blank = workspace folder name (or .wakatime-project file)." },
			{ key: "machine", label: "Machine name override", kind: "text",
				help: "Blank = this computer's hostname." },
			{ key: "sendEntityPath", label: "Send file paths", kind: "boolean",
				help: "Off replaces file paths with the project name. Turn off for privacy." },
			{ key: "sendAiUsage", label: "Report AI token usage", kind: "boolean",
				help: "Adds ai_model, ai_input_tokens and ai_output_tokens to heartbeats." },
			{ key: "rateLimitSeconds", label: "Rate limit (seconds)", kind: "number",
				help: "Minimum gap between two heartbeats for the same file. WakaTime's default is 30." },
			{ key: "debug", label: "Debug logging", kind: "boolean",
				help: "Log every heartbeat to the host console." },
		];

		// `settingsScope.bind` reads `connection` and `remote` off the CALLING
		// context, so both must be declared here alongside the services used.
		exports.inject = ["slots", "settingsScope", "connection", "remote"];

		function apply(ctx) {
			/**
			 * Mount the card in the best available seat. `settingsScope` is an
			 * optional service — dshmarket's own client injects it the same way
			 * — so the card stays registered on hosts that don't provide it by
			 * resolving to `null` for summary views and rendering nothing.
			 */
			const registerCard = (name, options, view) => {
				const render = view === "summary" ? null : HackatimeCard;
				if (render === null) return () => {};
				return ctx.slots.register({
					name,
					...options,
					// `reflect.get` needs no `inject` entry and returns
					// undefined when no locale plugin is loaded.
					inject: () => ({ scope, locale: ctx.reflect.get("locale") }),
				}, render);
			};

			const mounted = [];
			for (const slot of SLOT_CANDIDATES) {
				ctx.slots.inject(slot.name, () => {
					// A host may offer the seat without a scope to bind; only
					// mount when `settingsScope` is actually available.
					if (!ctx.settingsScope) return () => {};
					const dispose = registerCard(slot.name, slot.options);
					mounted.push(dispose);
					return () => {
						const i = mounted.indexOf(dispose);
						if (i >= 0) mounted.splice(i, 1);
						dispose();
					};
				});
			}

			// If this dsh declares neither seat, say so once so the silence
			// reads as a version gap rather than a broken plugin.
			const timer = setTimeout(() => {
				if (mounted.length > 0) return;
				console.warn(`[${NAMESPACE}] no settings card mounted: this dsh declares none of ` +
					`${SLOT_CANDIDATES.map((s) => s.name).join(", ")}. ` +
					`Keys can still be set in the profile's cordis.patch.yml.`);
			}, 5000);
			ctx.effect(() => () => clearTimeout(timer));
		}

		/**
		 * The card. `view` is the owner share of the config slots: `'summary'`
		 * asks for a compact tile (we render nothing, the row already shows the
		 * plugin name) and `'page'`/`undefined` asks for the full form.
		 */
		function HackatimeCard({ scope, view }) {
			// The Plugins page asks every config card to render a compact
			// summary tile before the user opens it; returning nothing there
			// is the documented behavior (dshmarket does the same).
			if (view === "summary" || !scope) return null;
			const snapshot = React.useSyncExternalStore(
				React.useCallback((listener) => scope.subscribe(listener), [scope]),
				() => scope.getSnapshot(),
			);
			const [drafts, setDrafts] = React.useState({});
			const [showSecret, setShowSecret] = React.useState(false);
			const [saving, setSaving] = React.useState(false);
			const [failed, setFailed] = React.useState("");

			const stored = (key) => {
				const value = snapshot.value?.[key];
				if (typeof value === "boolean") return value;
				if (typeof value === "number") return value;
				return typeof value === "string" ? value : "";
			};
			const draft = (key) => drafts[key] ?? stored(key);
			const dirty = Object.keys(drafts).filter((key) => drafts[key] !== stored(key));
			const disabled = saving || snapshot.writable === false;

			const save = async () => {
				setSaving(true);
				setFailed("");
				try {
					for (const key of dirty) {
						const value = drafts[key];
						if (value === "" || value === undefined) await scope.unset(key);
						else await scope.set(key, value);
					}
					// Writes swallow wire failures, so the host readback is the
					// only authority on what actually landed.
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

			const inputStyle = {
				width: "100%", boxSizing: "border-box", padding: "6px 8px",
				border: "1px solid var(--border, #444)", borderRadius: "6px",
				background: "var(--input-bg, transparent)",
				color: "var(--text, inherit)", fontSize: "13px",
			};
			const rowStyle = { marginBottom: "12px" };
			const labelStyle = {
				display: "flex", alignItems: "center", gap: "8px",
				fontSize: "13px", fontWeight: 500, marginBottom: "4px",
			};
			const helpStyle = { fontSize: "11.5px", opacity: 0.7, marginTop: "3px", lineHeight: 1.4 };

			const fields = FIELDS.map((field) => {
				const value = draft(field.key);
				let control;
				if (field.kind === "boolean") {
					control = React.createElement("input", {
						type: "checkbox", checked: Boolean(value), disabled,
						onChange: (e) => setField(field.key, e.target.checked),
					});
				} else if (field.kind === "number") {
					control = React.createElement("input", {
						type: "number", min: "5", max: "600", value: String(value ?? ""),
						disabled, style: inputStyle,
						onChange: (e) => setField(field.key, Number(e.target.value)),
					});
				} else if (field.kind === "secret") {
					control = React.createElement("div", { style: { display: "flex", gap: "6px" } },
						React.createElement("input", {
							type: showSecret ? "text" : "password", value: String(value ?? ""),
							placeholder: "from ~/.wakatime.cfg", disabled, style: inputStyle,
							spellCheck: false, autoComplete: "off",
							onChange: (e) => setField(field.key, e.target.value),
						}),
						React.createElement("button", {
							type: "button", disabled, onClick: () => setShowSecret((s) => !s),
							style: { padding: "4px 8px", fontSize: "12px" },
						}, showSecret ? "Hide" : "Show"),
					);
				} else {
					control = React.createElement("input", {
						type: "text", value: String(value ?? ""), disabled, style: inputStyle,
						spellCheck: false, autoComplete: "off",
						onChange: (e) => setField(field.key, e.target.value),
					});
				}
				return React.createElement("div", { key: field.key, style: rowStyle },
					React.createElement("label", { style: labelStyle }, control,
						React.createElement("span", null, field.label),
					),
					React.createElement("div", { style: helpStyle }, field.help),
				);
			});

			const hasKey = String(draft("apiKey") ?? "").trim().length > 0;
			const notice = !hasKey
				? "No API key set here — the plugin will read ~/.wakatime.cfg. If that file has no key, tracking stays paused until you add one."
				: null;

			return React.createElement("div", null,
				React.createElement("div", { style: { fontSize: "13px", marginBottom: "14px", lineHeight: 1.5 } },
					"Tracks your DeepSeek Harness sessions on ",
					React.createElement("a", { href: "https://hackatime.hackclub.com", target: "_blank", rel: "noreferrer" }, "Hackatime"),
					" as coding time. With no key set it reads the same ",
					React.createElement("code", null, "~/.wakatime.cfg"),
					" the WakaTime CLI uses, so an existing Hackatime install needs zero config.",
				),
				fields,
				notice && React.createElement("div", {
					style: { ...helpStyle, marginBottom: "12px", opacity: 1, color: "var(--warn, #e8a33d)" },
				}, notice),
				failed && React.createElement("div", {
					style: { ...helpStyle, marginBottom: "12px", opacity: 1, color: "var(--danger, #e5484d)" },
				}, failed),
				React.createElement("button", {
					type: "button", onClick: save,
					disabled: disabled || dirty.length === 0,
					style: { padding: "6px 16px", fontSize: "13px", borderRadius: "6px", cursor: disabled ? "default" : "pointer" },
				}, saving ? "Saving…" : `Save${dirty.length > 0 ? ` (${dirty.length})` : ""}`),
			);
		}

		return module.exports;
	},
});
