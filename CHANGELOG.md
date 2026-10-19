# Changelog

All notable changes to `dsh-hackatime` are documented here. Versions follow the
`dsh-hackatime` npm package; the DeepSeek Harness editor addition to Hackatime
itself lives in the `hackclub/hackatime` pull request.

## 0.4.0

Redesign of the settings tab around the single job a new user has — paste a key,
press Save — plus live tracking of the window you are actually working in, and a
hardening pass on the RPC channel before the plugin is submitted as an official
Hackatime plugin.

### Security hardening

- **The browser RPC route is now authenticated.** It was reachable by any
  process on the machine. It is gated exactly the way dsh gates its own `/api`
  route: the host's `connection.requestRejection` (Host/Origin fence + signed
  browser-session cookie), with a loopback/Origin-only fence for builds without
  it. DNS-rebinding and cross-site requests get `403`, an unauthenticated local
  request gets `401`, and the gate fails closed.
- **The API key is write-only on the read path.** `config.get` used to return
  the stored secret to whatever called it. It now comes back blank — the card
  learns "is a key set?" from the status payload and speaks new keys through
  `config.set`, which is the standard write-only secret pattern.
- **Config patches are allowlisted.** Only the plugin's own ten config keys may
  pass through `config.set`/`config.unset`; anything else (including
  `__proto__`) is dropped with a warning, so unknown keys can never reach the
  Settings service or the profile patch file.
- **The self-update profile argument is validated** as a plain
  `/[A-Za-z0-9._-]+/` token before being handed to a spawned `dsh`. That spawn
  runs through a shell on Windows, where shell metacharacters in the argument
  would have been executed.
- **Config persistence hardened** — the temp file now carries a random suffix
  and is created exclusively (it fails rather than following a symlink), and the
  atomic rename only lands on a path still verified to be a regular file.

### Heartbeat classification and pointers

- **Category is now `ai coding`**, per the Hackatime maintainers. Agent-driven
  work belongs in Hackatime's own AI Coding category rather than being blended
  into hand-edited time; verified against the production server.
- **The API key page link is now `https://hackatime.hackclub.com/api-key`**
  — the `/settings` link previously pointed at the wrong page.
- **The plugin icon is the real DeepSeek logo** (vectorized from the official
  asset) instead of a designed placeholder.

### Status

This is an independent community plugin. It is not yet certified by Hack Club,
so Hackatime may not count its time toward programs or leaderboards until it
is — certification is being pursued. The README states this plainly.

### Settings redesign

- **Onboarding-first settings card.** The default view is now three things:
  *Currently tracking*, a *Connect your Hackatime account* panel holding the API
  key field, and a collapsed *Advanced settings* disclosure. Connection stats,
  overrides and toggles moved behind the disclosure instead of sitting between
  the user and the Save button.
- **Numbered setup steps.** While no API key is set, the connect panel shows
  three numbered steps (create an account → copy your key → paste and Save).
  The steps disappear once a key exists.
- **Save lives next to the key.** The Save button moved into the connect panel,
  with a second one at the bottom of the expanded advanced section so an edit
  never requires scrolling back up.
- **Currently tracking shows the foreground window.** The card resolves the
  session in DSH's main view (the window you are actually looking at, not just
  whichever session last emitted an event) and sends its workspace to the host,
  which resolves the project name with the same rules a heartbeat uses
  (override → `.wakatime-project` → folder name). Degrades to the last recorded
  session when the card cannot resolve a foreground window.
- Faster status polling (3 s) so the tracked window feels live.
- Docs refreshed: full install walkthrough and troubleshooting in
  [docs/INSTALL.md](docs/INSTALL.md), screenshots of both card states.

## 0.3.8

Fixed the settings card loading with every field disabled when the plugin runs
under a browser-facing host. The client half did not declare the `connection`
service in its inject list, so `ctx.connection` was `undefined` in the browser
and every RPC settled as `unavailable`, leaving `config` null and the fields
permanently gated. Added `connection` to the inject and tightened
`test/render-page.mjs` so the mock context is derived from the declared inject
list — a missing service now fails the test instead of being hidden.

## 0.3.7

Fixed saves of a previously-set value to an empty string (for example clearing
the project override) being dropped from the persisted form, so the field
appeared to reset after a restart.

## 0.3.6

- `hasApiKey` is now derived live from the plugin config plus `~/.wakatime.cfg`,
  so the "No API key" warning clears the moment a key lands instead of on the
  next heartbeat.
- Resolved config values are live getters rather than a snapshot taken at RPC
  time.
- `enabled` is checked live at the top of `record()`, so the master switch
  pauses tracking immediately.

## 0.3.4 – 0.3.5

Fixed settings writes on a packaged-app web host. The host's `settings.update`
path dies in `configEditor.edit` with "profile reload requires the root Include
entry" because the host core and the profile plugins load two copies of
`dsh-app-boot`. `config.set` now applies the patch through the Loader entry
(volatile-only fast path), with a fallback that persists to the profile's
`cordis.patch.yml` by YAML AST surgery, written via temp file + `fs.rename` at
mode `0o600`.

## 0.3.2 – 0.3.3

The plugin's browser RPC is now served end-to-end over the DSH web-server route,
not only over the internal connection RPC, and the RPC registers even on hosts
whose settings service has no `register` (dsh ≥ 0.1.7).

## 0.1.0 – 0.3.1

Initial releases: WakaTime-compatible heartbeats from DSH session events, the
offline queue with backoff and permanent-rejection drop, `~/.wakatime.cfg`
inheritance, the settings card and the self-update path.
