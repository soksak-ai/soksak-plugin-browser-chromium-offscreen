# soksak-plugin-browser-osr

A browser for soksak that drives the bundled Chromium engine in **offscreen mode**.

Same engine and protocol as `soksak-plugin-browser-chromium`, opened with
`mode: "offscreen"` (docs/SIDECARS.md §8): the engine renders without a window
and presents its shared texture into a core-owned layer, composited inside the
view's cell. The DOM cell owns every input event and forwards it over the
protocol (`mouse`/`wheel`/`key`/`ime`, including Korean IME composition). It is
the reference consumer for eyeballing the offscreen hosting mode next to the
windowed browser.

## What it is

- **URL bar + engine cell.** Type a URL or search term, `이동`/Enter navigates.
  The cell is a transparent hole; the engine layer shows through beneath the
  main webview.
- **Offscreen, not windowed.** Unlike `browser-chromium` (which composites into
  its own native child view), this drives the engine's off-screen path — the
  same one the design canvas uses.
- **Weakly coupled.** Binds only through the manifest `sidecars[]` declaration
  and protocol messages; the core is a blind relay. No `eval`.

## Layout

- `src/plugin-entry.ts` — the view: URL bar, transparent cell, `create`
  (`mode: "offscreen"`), bounds-follow, engine event wiring (nav/title/cursor).
- `src/input-forward.ts` — DOM-event → protocol-message conversion
  (contract-tested in `input-forward.test.ts`; shared shape with the design
  plugin).

## Limitation

Off-screen frames are driven while the engine is active (load / input /
animation). Purely animated content freezes on its last frame after the idle
window until the next input — acceptable for v1.
