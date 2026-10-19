# Security

The plugin runs inside DeepSeek Harness on your own machine and talks to the
Hackatime API over HTTPS. This page documents the trust model and the controls
that keep your API key where it belongs.

## Reporting a problem

Open an issue at <https://github.com/namandhakad712/dsh-hackatime/issues>, or
email **dsh-hackatime@naman.is-a.dev**. Please do not paste your API key into a
public issue.

## The API key

- The key is stored in your plugin config with the `secret` role, and in the
  profile's `cordis.patch.yml` under mode `0o600`.
- The key is **write-only over the plugin's RPC channel**. The settings card
  never receives the stored value back — it only learns whether one is set
  (`hasApiKey` on the status payload) and speaks a new key through `config.set`.
- The key is never logged. Host logging covers errors, entity paths, versions
  and statuses; heartbeat debug logging records the file path and time only.
- Nothing except heartbeats (and a version check against the npm registry) ever
  leaves the machine, and no analytics or telemetry is collected.

## The browser RPC route

The settings card talks to the host half over a local HTTP route
(`/dsh-hackatime`). It is gated the same way dsh gates its own `/api` route:

- **Host/Origin fence** — the request must be loopback (or a host the host
  explicitly trusts), and any `Origin` must match it. A DNS-rebinding attempt or
  a cross-site page is refused with `403` before the body is even read.
- **Browser-session auth** — on dsh builds that expose it, the route requires
  the signed browser-session cookie the app itself mints, otherwise `401`.
  On builds without that API, a loopback/Origin-only fence takes over.
- The gate fails closed: anything that goes wrong while checking produces a
  `403`, never an open route.

## RPC payload handling

- Config writes are **allowlisted** to the plugin's own ten keys before they
  reach the Settings service or the profile patch file; anything else (including
  `__proto__`) is dropped with a warning.
- Endpoint paths are validated segment-by-segment; `..` and encoded traversal
  are rejected with `404`, the request method must be `POST`, the content type
  must be JSON, and bodies are capped.
- The `profile` argument to the self-update command is validated as a plain
  filesystem-safe token before it is ever handed to a spawned `dsh` — that
  spawn runs through a shell on Windows, where an unvalidated argument would be
  a command-injection vector.

## Profile file writes

Persistence writes the profile's `cordis.patch.yml` through a randomly-named
temp file created exclusively (fails rather than following a symlink), then
atomically renames it onto the patch path after verifying the target is still a
regular file. A crash mid-write cannot truncate your profile config.

## Scope

The plugin cannot reach files outside the active workspace, the profile
directory, or `~/.wakatime.cfg`. Its dependency surface is zero: no runtime
dependencies are shipped, so there is nothing to poison in the install tree.
