# Installing dsh-hackatime

A complete walkthrough for tracking your DeepSeek Harness coding time on [Hackatime](https://hackatime.hackclub.com) — written for someone who has never installed a DSH plugin before.

> **Requirements**
>
> - **DeepSeek Harness 0.1.6 or newer.** Older versions still work — the settings page falls back to a legacy slot, and the config keys still take effect through your profile's `cordis.patch.yml` — but 0.1.6+ is what the card is designed for.
> - **A Hackatime account** (free). Sign up at <https://hackatime.hackclub.com>.
> - **An API key** from <https://hackatime.hackclub.com/api-key>.
> - Optional: an existing `~/.wakatime.cfg` from a WakaTime or Hackatime setup. If you have one, you can skip step 4 entirely.

## What is DeepSeek Harness?

DeepSeek Harness (DSH) is the coding-agent IDE this plugin lives inside. It supports **plugins** — small packages that extend the app. `dsh-hackatime` is one: it watches your coding sessions and posts [WakaTime-style heartbeats](https://hackatime.hackclub.com/api-docs) to Hackatime, which sums them into the coding time on your dashboard.

## Step 1 — Install the plugin

In a terminal:

```sh
dsh plugin add dsh-hackatime
```

If you run DSH with a non-default profile, name it:

```sh
dsh plugin --profile myprofile add dsh-hackatime
```

## Step 2 — Restart DSH

Plugin bundles are picked up at startup, so a restart is required. After DSH comes back up, the plugin is already running in the background.

## Step 3 — Open the settings card

Go to **Settings → Plugins → Hackatime**. You should see the **Currently tracking** panel at the top with a **Live** or **Idle** pill — this is the panel that answers "is it actually tracking me?".

Don't see a Hackatime entry at all? You're probably on a DSH older than 0.1.6, where the card lives in a legacy slot, or the restart didn't happen. See [troubleshooting](#troubleshooting).

## Step 4 — Add your API key

The card's **Connect your Hackatime account** panel is the only thing you have to fill in:

1. Create a free Hackatime account at <https://hackatime.hackclub.com> ↗
2. Copy your API key from **Settings** → <https://hackatime.hackclub.com/api-key> ↗
3. Paste it into the **Hackatime API key** field and press **Save**.

That's the whole setup. The numbered steps disappear once a key is saved.

**Prefer the terminal or already use WakaTime?** Put the key in `~/.wakatime.cfg` instead and skip the card entirely:

```ini
[settings]
api_url = https://hackatime.hackclub.com/api/hackatime/v1
api_key = your-key-here
```

The plugin reads `[settings] api_url` and `[settings] api_key`, and re-reads the file only when it changes on disk. Fields you set on the card win over the file.

## Step 5 — Verify it's working

Open a project in DSH and work on something: send a message, edit a file, let the agent run a few tools. Back on the settings card:

- **Currently tracking** should name your project with a **Live** pill, and show the file and model it last saw.
- The **Connection** panel at the bottom should show heartbeats sent and a recent "Last delivered to server".

Then check your [Hackatime dashboard](https://hackatime.hackclub.com) — your time appears within about a minute. Everything else on the card (master switch, server URL, overrides, privacy toggles) is behind the **Advanced settings** disclosure and is optional.

## Troubleshooting

**No heartbeats showing in the Connection panel.** Work through the panel itself: what does **Last error** say? The common causes are "No API key set" (fix in step 4 or `~/.wakatime.cfg`), an `HTTP 401` (wrong key), and `HTTP 4xx/5xx` from an unreachable server. Also check the **Track coding time** master switch in Advanced settings — when it's off, nothing is recorded. Heartbeats are only sent at most once per 30 seconds per file, so a few seconds of waiting is normal.

**Time isn't appearing on my dashboard.** Give it about a minute — Hackatime sums consecutive heartbeats server-side and the pipeline is not instant. If the Connection panel shows heartbeats delivered but the dashboard stays empty, verify you're looking at the right project (the **Currently tracking** panel names it) and that your dashboard isn't filtering by editor.

**All the fields on the card are disabled.** The card couldn't reach the plugin's host half. This happens on DSH builds older than 0.1.6 — upgrade to 0.1.6 or newer. (On those older builds the config still works if you write it into your profile's `cordis.patch.yml` by hand.)

**The wrong project name shows up.** By default the project is your workspace folder name. Two fixes: set **Project name override** in Advanced settings, or — the more portable option — create a `.wakatime-project` file in your workspace root whose first line is the project name:

```
my-cool-project
```

The marker file wins over the override field.

**The wrong machine name shows up.** It defaults to your computer's hostname. Set **Machine name override** in Advanced settings to change it.

## Self-hosted Hackatime

Running your own WakaTime-compatible server? Open **Advanced settings**, set **API base URL** to your endpoint (for example `https://hackatime.myserver.com/api/hackatime/v1`), and save. The plugin POSTs to `{apiUrl}/users/current/heartbeats` with `Authorization: Bearer <api_key>` — nothing else is hardcoded about Hackatime.

## Privacy options

- **File paths** are sent as the `entity` field by default, so Hackatime can attribute time to specific files. Turn **Send file paths** off (Advanced settings) and only the workspace folder name is sent.
- **AI token usage** is reported by default (`ai_model`, `ai_input_tokens`, `ai_output_tokens`). Turn **Report AI token usage** off if you don't want it.
- Your **API key** is stored with the `secret` role and never appears in logs.
- No **analytics or telemetry** — the only traffic is your heartbeats, plus a version check against the npm registry for the update notice.

## Uninstall

```sh
dsh plugin remove dsh-hackatime
```

Any heartbeats already delivered stay on your Hackatime dashboard; queued-but-unsent ones are dropped with the plugin.

## FAQ

**Do I need a WakaTime account?** No. `dsh-hackatime` talks to Hackatime (or any WakaTime-compatible server) directly. The `~/.wakatime.cfg` file is just a convenient convention it happens to read.

**Does it send my code?** No. It sends file *paths*, timestamps, language metadata, and token counts — never file contents.

**Does it count time when I'm away from the keyboard?** No. A heartbeat is only emitted when real activity happens: you send a message, the agent runs a tool on a file, or a model turn finishes. Nothing is timed while you're idle, and heartbeats for the same file are rate-limited.

**What if I'm offline?** Heartbeats queue up in memory and are retried with backoff when the connection comes back. A permanent rejection (HTTP 400/422) drops the heartbeat instead of retrying it forever.

**Can I pause it without uninstalling?** Yes — flip the **Track coding time** switch in Advanced settings. The card keeps working so you can see the paused state.

**How does it know what counts as an edit?** Write tools are detected by name (`write`, `edit`, `str_replace_editor`, `apply_patch`, `create_file`, and similar). Read-only tools like `read`, `glob` and `grep` only produce a heartbeat when their result returns, so browsing files doesn't look like editing them.

**Why is the editor "DeepSeek Harness" and not a browser?** Because Hackatime only counts leaderboard time for known editors, and `dsh-hackatime` reports `editor: DeepSeek Harness` on every heartbeat — never a browser name.
