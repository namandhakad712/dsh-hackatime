# dsh-hackatime

A [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-AS-Review) (DSH) plugin that counts the time you spend in the agent as coding time on [Hackatime](https://hackatime.hackclub.com).

If you use DeepSeek Harness as your daily driver but your Hackatime leaderboard only sees your editor time, this plugin is for you. It sends [WakaTime-style heartbeats](https://hackatime.hackclub.com/api-docs) for the files the agent reads and writes, so your agent-driven work counts too.

## How it works

The plugin subscribes to DSH's `session/event` stream and posts one heartbeat to the Hackatime API whenever you send a message, the agent calls a tool on a file, a tool call returns, or the assistant emits a message with token usage. Heartbeats are sent at most once per `rateLimitSeconds` (default 30, matching WakaTime's convention) for each distinct file, queued when offline, and retried with backoff. A permanent server rejection (HTTP 400/422) drops the heartbeat instead of retrying forever.

Every constant is taken from the Hackatime server source, not guessed:

- `POST {api_url}/users/current/heartbeats` with `Authorization: Bearer <api_key>`
- `time` is Unix epoch **seconds** (the server rejects anything outside `1000000000`–`2000000000`)
- `category` is always `coding`, `editor` is `DeepSeek Harness` (never a browser name, so the time stays leaderboard-eligible)
- `project` is never the `<`/`>` sentinel WakaTime uses for "unchanged"

## Install

You need DSH 0.1.6 or newer (the plugin settings card uses the `plugins.bundle.config` slot; on older versions it falls back to the `settings.plugin.item` slot, and if neither exists it stays silent while the config keys still work through the profile's `cordis.patch.yml`).

```sh
dsh plugin --profile <name> add dsh-hackatime
```

Then restart DSH. Bundle installs are picked up at startup.

## Configure

The plugin works with zero configuration if you already have a WakaTime-compatible setup: it reads `~/.wakatime.cfg`'s `[settings]` section for `api_url` and `api_key`, and only re-reads the file when it changes on disk.

If you don't have one, get an API key at <https://hackatime.hackclub.com/settings> and either add it to `~/.wakatime.cfg`:

```ini
[settings]
api_url = https://hackatime.hackclub.com/api/hackatime/v1
api_key = your-key-here
```

or open **Settings → Plugins → Hackatime** in DSH and fill in the fields.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `apiKey` | _(from `~/.wakatime.cfg`)_ | Hackatime API key. Never logged. |
| `apiUrl` | `https://hackatime.hackclub.com/api/hackatime/v1` | API base URL. Point this at a self-hosted server if you run one. |
| `project` | _(workspace folder name)_ | Project name override. A `.wakatime-project` file in the workspace root wins over this. |
| `machine` | _(hostname)_ | Machine name override. |
| `rateLimitSeconds` | `30` | Minimum gap between two heartbeats for the same file. |
| `sendEntityPath` | `true` | Send the full file path as `entity`. Turn this off for privacy; the workspace folder name is sent instead. |
| `sendAiUsage` | `true` | Send `ai_model`, `ai_input_tokens` and `ai_output_tokens` on heartbeats that carry them. |
| `debug` | `false` | Log every heartbeat to the host console. |
| `autoUpdate` | `true` | Install the newest published `dsh-hackatime` automatically. Turn it off to update manually from the settings tab. |

## The settings tab

**Settings → Plugins → Hackatime** shows live tracking, not just a form:

- **Connection** — whether the server is reachable, how many heartbeats have landed, and a link to your dashboard.
- **Currently tracking** — the project, file, model and session the plugin is timing right now, with a Live/Idle pill. This is the answer to "is it actually tracking me?".
- **Settings** — every field above, autofilled from your stored config and editable inline.
- **How to use it** — the setup walkthrough, on the page.

When a newer version is published, the tab shows a banner (`v1.2.3 is available`) with an **Update now** button. With `autoUpdate` on, the host installs it on its own.

## What gets recorded

| Event | Heartbeat |
| --- | --- |
| You send a message | one, `is_write: false` |
| The agent calls a tool on a file | one, `is_write` set for write tools |
| A tool call returns | one, `is_write` inherited from the call |
| The assistant emits a message with token usage | one, tagged with AI usage |

Write tools are detected by name: `write`, `edit`, `str_replace`, `apply_patch`, `create_file`, and similar. Read tools (`read`, `glob`, `grep`) only generate a heartbeat through their tool result, so a file you merely list doesn't look like an edit.

The language is inferred from the file extension (Dockerfile → `Dockerfile`, `.js` → `JavaScript`, and so on). Unknown extensions are left unset, and the server's own `LanguageUtils` fills them in as `Unknown`.

## Privacy

The API key is stored in your plugin config with the `secret` role and is never logged. File paths are sent as the `entity` field by default; turn **Send file paths** off to send only the workspace folder name. No analytics, telemetry, or third-party calls are made by this plugin beyond the heartbeats you configure it to send.

## Uninstall

```sh
dsh plugin --profile <name> remove dsh-hackatime
```

## License

MIT
