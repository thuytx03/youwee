# Vendored Elah (elahlabs/elah)

Source vendored from https://github.com/elahlabs/elah (main branch,
`@elah/core@0.3.2`, `@elah/editor`, `@elah/timeline`) under the Apache-2.0
license (see `LICENSE`/`NOTICE`, and per-package `LICENSE` files).

Vendored instead of consumed via npm so we can fix a WebKit/Tauri-specific
rendering bug (video preview rendered upside-down in the desktop webview)
and make further custom adjustments as needed.

## Changes made vs. upstream

- `core/src/media/video/StreamingFrameProducer.ts`: fixed the preview
  upside-down bug on WebKit (Tauri's macOS webview) — see inline comment.

## Wiring

`vite.config.ts` aliases the `@elah/core`, `@elah/editor`, `@elah/timeline`
bare specifiers to this directory's `src/index.ts` entry points, so the rest
of the app imports them exactly as it did from the npm packages.
