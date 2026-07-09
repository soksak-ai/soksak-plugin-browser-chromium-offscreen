# soksak-plugin-browser-chromium-offscreen

A browser for soksak that drives the bundled Chromium engine in **offscreen mode**.

Same engine and protocol as `soksak-plugin-browser-chromium`, opened with
`mode: "offscreen"` (docs/SIDECARS.md §8): the engine renders without a window
and presents its shared texture into a core-owned layer, composited inside the
view's cell. The DOM cell owns every input event and forwards it over the
protocol (`mouse`/`wheel`/`key`/`ime`, including Korean IME composition). It is
the reference consumer for eyeballing the offscreen hosting mode next to the
windowed browser.

## What it is

- **Full toolbar** — back / forward / reload (toggles to stop while loading) /
  home / URL bar / bookmark star, with a loading progress bar. Back and forward
  dim when there is no history in that direction.
- **Offscreen, not windowed.** Unlike `browser-chromium` (which composites into
  its own native child view), this drives the engine's off-screen path — the
  same one the design canvas uses. The cell is a transparent hole; the engine
  layer shows through beneath the main webview.
- **One surface per view.** Re-mounts close the prior surface first so stacked
  offscreen surfaces never occlude the active cell.
- **Weakly coupled.** Binds only through the manifest `sidecars[]` declaration
  and protocol messages; the core is a blind relay. No `eval`.

## Usage

```bash
sok view.open '{"program":"browser-chromium-offscreen"}'
sok plugin.soksak-plugin-browser-chromium-offscreen.navigate '{"url":"https://example.com"}'
```

A new tab opens at `homeUrl`, or restores its last URL (`data.kv vurl:<viewId>`).

## Commands

`ping`, `navigate`, `back`, `forward`, `reload`, `stop`, `home`, `open`, `stats`
(surface ids + engine `framesPresented`). Each acts on the active view; pass
`viewId` to target a specific one.

## Settings

| key | default | description |
|---|---|---|
| `homeUrl` | `https://example.com` | address a new tab opens to |
| `browserNewWindow` | `tab` | open `target=_blank` / `window.open` links in a new tab or a new window |

## Layout

- `src/plugin-entry.ts` — the view: toolbar, transparent cell, `create`
  (`mode: "offscreen"`), bounds-follow + visibility, engine event wiring
  (nav / title / cursor / loading / popup-url), commands, bookmarks, URL restore.
- `src/input-forward.ts` — DOM-event → protocol-message conversion
  (contract-tested in `input-forward.test.ts`; shared shape with the design
  plugin).

## Limitation

Off-screen frames are driven while the engine is active (load / input /
animation). Purely animated content freezes on its last frame after the idle
window until the next input — acceptable for v1.
