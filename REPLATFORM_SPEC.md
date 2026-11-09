# Athanor: Alchemy Web Replatform Specification (REPLATFORM_SPEC.md)

Status: Implementation-ready architecture blueprint, v1.0
Source analyzed: `karldd/Alchemy` (Java 1.5, Swing/Java2D, JPen, JPF, Batik, iText, Beads), 91 Java files, ~25.6k LOC, `src/org/alchemy/{core,create,affect}`, `modules/*/plugin.xml`, `shapes/*`.
Method: clean-room static analysis. Legacy behavior is described as observable contracts; no Java syntax or AWT/Swing idioms are carried over.
Target: purely client-side, local-first TypeScript web app (installable PWA). No backend, no accounts, no server rendering. Multi-route app shell (home file browser, editor, settings) around the Alchemy canvas engine. Files are multi-page documents stored in the browser. Network used only to load and update the static app; every feature works offline once installed. App shell, storage, pages, undo and PWA are specified in section 8.

Notation:
- `p = (x, y)` CSS-pixel canvas coordinates unless suffixed `_dev` (device pixels = CSS px x `dpr`).
- `U[a, b)` uniform random from the session PRNG. `N(mu, sigma)` Gaussian.
- `int(v)` truncation toward zero (Java `(int)` cast parity). `idiv(a, b)` integer division truncating toward zero.
- `[LEGACY BUG]` = defect found in source; spec states the corrected web behavior.
- `[UNKNOWN]` = unresolvable from source; spec states the default decision taken.
- `[DIVERGENCE]` = intentional behavior change for the web.

---

## 0. Source Findings That Shape This Spec

These facts were verified in source and override assumptions in the original brief.

| # | Finding | Source | Spec consequence |
|---|---|---|---|
| F1 | Undo exists but is optional: pref `Undo Depth` 0/1/2 (default 0 = off), stroke groups via `startUndoGroup/finishUndoGroup`. | `AlcCanvas`, `AlcPreferences` | Undo/redo is ON in the web app (product decision), implemented as an operation history over the committed log (8.5). Legacy default-off is not kept. |
| F2 | An eraser exists only as a second color slot (slot 1, default white) auto-selected when the tablet reports the eraser end. There is no pixel erase. | `AlcCanvas` pen kind listener | Pen eraser end (`buttons & 32`) selects color slot 1. No erase tool. |
| F3 | `AlcMicrophone` has no pitch detection. Level = mean absolute 16-bit sample / 100 (range 0 to 327.68). Not RMS. | `AlcMicrophone.getMicLevel` | Web audio worklet computes legacy `meanAbs/100` for parity, plus RMS for new modules. |
| F4 | Pitch exists only in `PitchShapes` (Beads lib): frame 2048, hop 777, FFT, power spectrum, 10 spectral peaks, energy-weighted mean frequency, gate `peak0.energy > 1000`. | `PitchShapes` | Specified in 4.1.4 on `AnalyserNode`. |
| F5 | Blindness has no timer. "Auto-reveal" = one forced full redraw on pointer release. Key `R` reveals. | `Blindness` | No timers. |
| F6 | PullShapes loads PDF vector files from `./shapes/` subfolders (bundled sets: Bones, Circles, Parts, Tanagram). Not SVG. | `PullShapes.loadShapes` | Bundled sets re-authored as SVG at build time into a static manifest. User adds SVG by drop/file input. |
| F7 | TraceShapes downloads a random Flickr image via a hard-coded API key (endpoint obsolete) or loads one from disk. | `TraceShapes.downloadImage` | Flickr removed. File, drop, paste, webcam sources. |
| F8 | Modules beyond the brief: `PressureShapes`, `PitchShapes`, `XShapes`, `TypeShapes`, `EvolveShapes` (create); `ShapeSwap` (affect). | `src/org/alchemy/*` | All in registry except `ShapeSwap` (unfinished XML experiment writing `foo.xml` to CWD) which is dropped. |
| F9 | No foreground/background swap. Key `X` toggles current color to background color and back to `previousColor`. | `AlcShortcuts` | Ported as "Swap to background" plus a new web "swap fg/bg" binding. |
| F10 | "Switch Vector/Bitmap" writes temp PDF/SVG/PNG and launches a native app (`open -a`, absolute exe path). | `AlcMenuBar`, `AlcUtil` | Blocked by browser sandbox. Replaced (7.4). |
| F11 | `commitShapes()` flattens by re-rendering old buffer + active shapes into a new image, then appends to the retained list. Guides are baked into the buffer when visible. | `AlcCanvas.commitShapes` | [LEGACY BUG] guides never baked. Commit is incremental raster, not full re-render. |
| F12 | Affect modules that act on committed shapes (Random, Smooth, MicExpand, Repeat source, Limit) trigger full `redraw(true)` = O(N) re-render of all shapes. | `affect/*` | Replaced by dirty-tile replay (2.6). |
| F13 | Session recording is a Swing timer that saves a page only if the canvas changed, appending to a multi-page PDF on disk. | `AlcSession` | Each snapshot becomes a new page in the current document (8.4); PDF is an export of the pages. |

---

## 1. Core Philosophy & Browser UX Paradigm

### 1.1 Ethos

Alchemy is a serendipitous visual brainstorming instrument, not an illustration editor. Its contracts:

| Principle | Contract |
|---|---|
| Generative, not editorial | No selection, no erase, no layers panel, no object editing UI. Shapes, once committed, are mutated only by generative affect modules (Random, Smooth, MicExpand, Repeat, Limit), never by direct manipulation. Undo/redo exists (8.5) as a safety net, not as an editing tool. |
| Rapid generation | Shapes appear on the first pointer sample. Zero modal dialogs during drawing. Every control is reachable in one keystroke. |
| Blind drawing | Blindness suppresses active-layer rendering. The artist sees only committed results on reveal. |
| Timed resets | Session recording snapshots the canvas every N ms into a page; optional auto-clear after each snapshot forces new beginnings. |
| Distraction-free surface | Full-viewport canvas. HUD is hidden by default and summoned by proximity or key. |
| Determinism for testing only | Runtime randomness uses a seeded PRNG. The seed is random per session in production and fixed in tests. |

### 1.2 Unified Pointer Model

All input enters through one normalized sample type (`InputSample`, layout in 3.1). Legacy JPen polled at 200 Hz; the web uses event-driven sampling with coalescing (4.2).

| Field | mouse | pen | touch |
|---|---|---|---|
| `x, y` | `offsetX/Y` relative to the canvas (via cached `getBoundingClientRect`, refreshed on resize/scroll only) | same | same |
| `pressure` raw | `0.5` while `buttons != 0` per spec, ignored | `PointerEvent.pressure` in [0, 1] | `pressure` if `> 0` and not exactly `0.5` (hardware-reported), else synthetic |
| `pressureEff` | synthetic (1.2.1) | `raw^2` (legacy "parabolic sensitivity" parity) | `raw^2` if hardware, else synthetic |
| `tiltX, tiltY` | 0 | `tiltX/tiltY` degrees in [-90, 90]; if only `altitudeAngle/azimuthAngle` exist, derive `tiltX = atan(cos(az)/tan(alt))`, `tiltY = atan(sin(az)/tan(alt))` in degrees | 0 |
| `penKind` (legacy `PEN_*`) | `CURSOR = 3` | `STYLUS = 1`; `ERASER = 2` when `buttons & 32` | `STYLUS = 1` (treated as pen so pressure modules respond) |
| primary filter | `button === 0` | `isPrimary` | first `isPrimary` touch only; secondary touches feed gesture recognizer (1.3.2) |

Legacy parity rules:
- PressureShapes: width = 1 when `penKind == CURSOR`, else `pressureEff * pressureAmount`. On web, `CURSOR` gets synthetic pressure only if the user enables pref `syntheticPressure` (default ON for mouse and touch, since legacy mice drew constant width 1 which looks broken on modern hardware). [DIVERGENCE]
- EvolveShapes: scale = `pressureEff * 2`, or 1 for `CURSOR` (synthetic ignored, legacy parity).
- Pen location updates on hover (legacy tracked pen position with pen up). Web: `pointermove` with `buttons == 0` updates `penLocation` for pen and mouse.

#### 1.2.1 Synthetic Pressure (velocity-based)

For samples without hardware pressure. Per sample i with previous accepted sample i-1:

```
dt_i   = max(1, t_i - t_{i-1})                      (ms, from event.timeStamp)
v_i    = hypot(x_i - x_{i-1}, y_i - y_{i-1}) / dt_i (px/ms)
vs_i   = vs_{i-1} + alpha_v * (v_i - vs_{i-1})       alpha_v = 0.25, vs_0 = 0
pSyn_i = clamp(1 - vs_i / vMax, pMin, 1)            vMax = 3.0 px/ms, pMin = 0.15
pEff_i = pSyn_i ^ gamma                             gamma = 1.0 (pref, range 0.5 to 2)
```

First sample of a stroke: `pSyn_0 = 0.6` (fast strokes thin, slow strokes thick, mirroring ink behavior). Constants are prefs under `alchemy.v1.input.*`.

### 1.3 Keyboard and Touch Controls

#### 1.3.1 Hotkey Map (legacy parity, `KeyboardEvent.code`)

`Mod` = `metaKey` on macOS (`navigator.userAgentData?.platform` or `/Mac|iP/` UA test), else `ctrlKey`. Bindings fire only when focus is on the canvas host or `document.body`; never while a HUD text/number input is focused.

| Code | Mod | Action | Legacy | Web notes |
|---|---|---|---|---|
| `Tab` | - | Toggle HUD main bar / swatch bar, show HUD "keyed-on" | TAB | `preventDefault` only when focus is on canvas host; Tab inside HUD keeps native focus traversal |
| `Space` | - | Toggle HUD visibility (TypeShapes active: auto-generate instead) | SPACE | TypeShapes consumes `Space` on keyup (legacy) |
| `KeyH` | - | Toggle hidden cursor (`cursor: none`) / crosshair | H | |
| `KeyI` | - | Eyedropper (next click samples canvas pixel) | I | Samples composited committed+active pixel via worker `getImageData(1x1)`; optional `EyeDropper` API (Chromium) behind `Shift+I` for screen-wide pick |
| `KeyX` | - | Toggle color to background color / back to previous | X | |
| `KeyX` | Shift | Swap fg/bg colors | none | [DIVERGENCE] new |
| `KeyS` | - | Toggle style stroke/fill | S | |
| `KeyD` | - | Toggle draw under/over | D | |
| `BracketLeft` / `BracketRight` | - | Line width -1 / +1, clamp [1, 75] | [ ] | |
| `Digit1..Digit9, Digit0` | - | Select create module 1..10 | 1-0 | |
| `Digit1..Digit0` | Alt | Select create module 11..20 | ALT+digit | [LEGACY BUG] off-by-one fixed: Alt+1 = module 11 |
| `Digit1..Digit0` | Mod | Toggle affect module 1..10 | MOD+digit | |
| `Digit1..Digit0` | Mod+Shift | Toggle affect module 11..20 | SHIFT+digit | fixed off-by-one |
| `KeyZ` | - | Zoom 4x at pointer / unzoom | Z | Only when pointer over canvas |
| `NumpadMultiply` / `NumpadDivide` | - | Alpha +10 / -10, clamp [0, 255] | same | Also `Equal`/`Minus` with Alt for laptops |
| `NumpadAdd` / `NumpadSubtract` | - | Next / previous swatch color (wrap) | same | |
| `NumpadDecimal` | - | Repeat last swatch modulation | same | |
| `Numpad0..Numpad9` | - | Pick swatch i | same | Applies swatch alpha unless alpha locked |
| `Backspace` | Mod | Clear canvas | MOD+Backspace | |
| `Backspace` | Mod+Shift | New (confirm if shapes exist, then clear and reset session) | MOD+N | Remapped: `Ctrl+N` is browser-reserved |
| `KeyE` | Mod | Export dialog | MOD+E | |
| `KeyC` | Mod | Copy canvas (PNG + SVG) to clipboard | MOD+C | Only when no text selection exists in HUD |
| `Semicolon` / `Quote` | Mod | Flip horizontal / vertical | same | |
| `KeyF` | Mod+Shift | Fullscreen toggle | MOD+F | Remapped: `Ctrl+F` is find; `Escape` exits (native) |
| `KeyS` | Mod | Save session page (to in-memory PDF) | MOD+S | `preventDefault` works in all engines |
| `KeyD` | Mod | Save page and clear | MOD+D | `preventDefault` (bookmark) works in Chromium/Firefox; Safari: fallback `Alt+KeyD` |
| `KeyR` | Alt | Toggle session recording | MOD+R | Remapped: `Ctrl+R` reload cannot be safely stolen |
| `KeyZ` | Mod | Undo | MOD+Z | 8.5 |
| `KeyZ` | Mod+Shift | Redo | none | also `Mod+KeyY` on Windows/Linux |
| `PageDown` / `PageUp` | - | Next / previous page | none | 8.4 |
| `KeyN` | Alt | New page | none | 8.4 |
| `KeyK` | Mod | Command palette | none | 8.3 |
| `Backslash` | Mod | Toggle pages panel | none | 8.3 |
| `ArrowRight` / `ArrowLeft` | Mod | Next / previous page of loaded session PDF | same | |
| `KeyL` | Alt | Load background image | MOD+L | Remapped: address bar |
| `KeyP` | Mod | Print (PNG of canvas into print iframe) | MOD+P | |
| `Comma` | Mod | Open settings | MOD+O | Remapped |
| `KeyR` | - | Blindness: reveal | R | Only when Blindness active |
| `KeyB` | - | Repeat: toggle repeat | B | Only when Repeat active |
| any printable | - | TypeShapes key drawing (if `keys` on) | keyReleased | Uses `KeyboardEvent.key` first char |

Dropped: `MOD+T` transparent fullscreen (desktop screen capture backdrop, 7.4), `MOD+V/B` switch apps (7.4).
Keyboard Lock: when in fullscreen on Chromium, call `navigator.keyboard.lock(['KeyN','KeyR','KeyL','KeyF','KeyO'])` to restore original legacy chords; feature-detected, never required.
Custom bindings: stored as `alchemy.v1.keys` (3.3). Editor rejects lone modifiers and duplicates (legacy parity), shows invalid state 1500 ms.

#### 1.3.2 Touch Controls (tablet browsers without keyboard)

Recognizer runs on non-primary touches only; primary touch always draws. Thresholds: tap = down/up within 250 ms and < 10 px travel per finger.

| Gesture | Action |
|---|---|
| 2-finger tap | Undo (tablet convention) |
| 3-finger tap | Redo |
| 4-finger tap | Toggle toolbar expanded/collapsed |
| 2-finger long-press 600 ms | Clear page (undoable). A 600 ms radial progress ring is shown first; lifting a finger cancels |
| Blindness, style, module switching | Via the floating toolbar (no gesture) |
| Edge swipe down from top 24 px | Show HUD |
| Primary touch starting a stroke cancels any pending gesture | |

When a second touch lands mid-stroke, the active stroke is committed (not discarded) and the gesture recognizer takes over.

### 1.4 Distraction-Free Viewport, Floating Toolbar and Proximity HUD

Product decision: the editor opens in **focus mode**: full-viewport canvas plus a small always-present floating toolbar (8.3.2). The full HUD (sub-toolbars, swatches) described below is summoned from the floating toolbar, by key, or by top-edge proximity. The docked mode remains as a pref.

Legacy `AlcToolBar.toggleToolBar(y)`: show when `y < 10`, hide when `y > totalHeight + 5` (immediately, or after 1000 ms if a popup is open), canvas events disabled while toolbar is shown, any canvas click below hides it. `AlcSimpleToolBar` is a permanent 150 px left sidebar.

Web HUD state machine (states: `HIDDEN`, `PEEK`, `SHOWN`, `KEYED`, `DOCKED`):

| From | Event | Guard | To | Effects |
|---|---|---|---|---|
| HIDDEN | pointermove | `y < 10` and no stroke active | SHOWN | opacity 1 (120 ms ease), `canvasEvents=false` while pointer inside HUD rect only |
| HIDDEN | pointermove | `y < 48` | PEEK | opacity `= 1 - (y - 10)/38` (continuous proximity fade), pointer-events none |
| PEEK | pointermove | `y >= 48` | HIDDEN | opacity 0 |
| SHOWN | pointermove | `y > hudHeight + 5`, no popup open | HIDDEN | opacity 0 (200 ms) |
| SHOWN | pointermove | `y > hudHeight + 5`, popup open | SHOWN | arm 1000 ms timer; on fire, hide if pointer outside HUD and popups |
| any | pointerdown on canvas | `state != DOCKED` | HIDDEN | stroke starts on same event (legacy swallowed nothing below the bar) |
| any | stroke active | - | (frozen) | HUD forced to opacity 0 during strokes, restores after `pointerup + 300 ms` |
| HIDDEN | `Tab`/`Space` | - | KEYED | shown; ignores proximity hide until pointer enters then leaves HUD |
| any | pref `hudMode = docked` | - | DOCKED | permanent left rail (legacy Simple toolbar, 150 px), canvas offset 150 px |

Implementation constraints: HUD is DOM over the canvas, `position: fixed`, `contain: layout paint style`, only `opacity` and `transform` animated (compositor-only), `pointer-events: none` when opacity is 0. Proximity uses the already-normalized pointer stream (no extra listeners). Zero layout reads during strokes.

---

## 2. Dual-Buffer Canvas Engine & Module Pipeline

### 2.1 Layer Stack (DOM, bottom to top)

| z | Element | Owner thread | Context | Content | Redraw policy |
|---|---|---|---|---|---|
| 0 | `<canvas id="committed">` | Render worker via `transferControlToOffscreen()` | 2D `{alpha:false, desynchronized:true}` | Background color, background image (if displayed), baked base, committed shapes | Incremental: append on commit; dirty-tile replay on mutation (2.6) |
| 1 | `<canvas id="active">` | Main thread | 2D `{alpha:true, desynchronized:true}` | `createShapes`, `affectShapes`, pending-commit shapes | Every rAF with dirty flag; clears union of previous and current dirty bbox |
| 2 | `<canvas id="guides">` | Main thread | 2D `{alpha:true}` | `guideShapes` (Shapes straight-line guide, Mirror axis crosshair), record indicator | Only on guide change |
| 3 | `<div id="hud">` | Main thread | DOM | Toolbars, popups, dialogs, toasts | Reactive (Preact signals) |

Rules:
- All three canvases share one CSS box (`position:absolute; inset:0`) and the same device-pixel backing size `(round(cssW*dpr), round(cssH*dpr))` from `ResizeObserver` `devicePixelContentBoxSize` (fallback `contentBoxSize * dpr`).
- `desynchronized` is a hint. Feature check via `getContextAttributes().desynchronized`. When unsupported, behavior is identical with normal vsync latency.
- `drawUnder` (legacy D key): active layer stays on top for visibility during the stroke (legacy drew the buffer over active shapes, hiding them; [DIVERGENCE] the active layer is rendered at 35% opacity so the user still sees the stroke), and commit inserts shapes at log index 0, which dirties every tile the shape touches (2.6).
- Background color and background image live on the committed canvas, not CSS, so exports and eyedropper see one composited source.

### 2.2 Shape Lists and Ownership

| Legacy list | Web store | Thread | Lifetime |
|---|---|---|---|
| `createShapes` | `ActiveArena.create` (3.2) | main | Until commit |
| `affectShapes` | `ActiveArena.affect` | main | Until commit |
| `guideShapes` | `GuideList` (small JS array, max 8 entries, preallocated) | main | Module-controlled |
| `shapes` (committed) | `CommittedLog` (3.2.3) + `SpatialGrid` (2.6) | render worker | Until clear, Limit removal, or baking (2.7) |
| `shapeGroups` (undo) | `HistoryLog` (8.5) | render worker | Per page, bounded by undo budget |

### 2.3 Frame Pipeline (main thread)

Input handlers never run module logic. They append to the input ring and set `inputDirty`. One `requestAnimationFrame` callback (`tick`) does all work:

```
tick(frameTime):
  1. drain InputRing in order (samples since last tick, including coalesced)
     for each sample s:
        route s through HUD hit test (cached rect) -> if inside HUD and HUD SHOWN: skip
        dispatch to current create module hook (pointerDown/Move/Drag/Up)  [if createEvents]
        dispatch to each active ACTIVE-domain affect module hook, ascending order  [if affectEvents]
        forward hover samples (buttons==0) to render worker if any COMMITTED-domain affect is active (batched, 1 message per tick)
  2. if any geometry changed this tick (or module requested redraw):
        for each active ACTIVE-domain affect module, ascending order: affect()   (legacy applyAffects)
  3. drain AudioRing -> update MicState (latest level, latest sample block)
  4. timers: module timers evaluated against frameTime (no setTimeout in hot path)
  5. render active layer (2.4) unless Blindness redraw=false
  6. flush outbound worker messages (commit batches, hover batch)
  7. schedule next rAF only if: stroke active OR any module has continuous behavior (Ribbon physics, MicExpand, MicShapes, Pitch) OR pending animations; else idle
```

Legacy semantics are per-event (e.g., ScrawlShapes counts drag events, SpeedShapes uses per-event deltas). Processing each sample individually inside the tick preserves them exactly, while rendering once per frame.

Budget per tick (8.0 ms at 120 Hz): input drain + modules <= 2.0 ms, affects <= 1.0 ms, active render <= 3.0 ms, messaging <= 0.3 ms, slack >= 1.7 ms. Instrumented with `performance.now()` deltas into a 120-slot `Float32Array` ring (debug HUD only).

### 2.4 Active Layer Render Contract

Per active shape record (3.2.2) in order `create[]`, `affect[]`, `pendingCommit[]`:

1. `ctx.beginPath()`; walk the command stream emitting `moveTo / lineTo / quadraticCurveTo / bezierCurveTo / closePath` directly from the vertex `Float32Array`. No `Path2D` allocation in the hot loop.
2. Paint selection: if gradient index >= 0, use a cached `CanvasGradient` keyed by `(shapeId, gradientVersion)` (recreated only when its endpoints change; Gradient module changes them per frame only for pen-drawn shapes, max 1 allocation per shape per frame, accepted and bounded by active shape count <= 64); else `fillStyle/strokeStyle` set from cached CSS color string keyed by packed RGBA (LUT of last 32 strings, no string building per frame).
3. Style: `STROKE` => `lineWidth`, `lineCap='round'`, `lineJoin='bevel'` (legacy `BasicStroke(CAP_ROUND, JOIN_BEVEL)`), `ctx.stroke()`. `FILL` => `ctx.fill(winding)` with `winding = 'nonzero'` default, `'evenodd'` if record flag set.
4. `imageSmoothingEnabled` irrelevant; antialiasing always on (legacy Smoothing pref default true; when false, [DIVERGENCE] web cannot disable 2D AA, pref is dropped).
5. Dirty region: the record bbox (inflated by `lineWidth/2 + 2`) unioned into `dirtyNow`. Clear `dirtyPrev ∪ dirtyNow` with `clearRect`, clip to it, redraw only intersecting records. `dirtyPrev = dirtyNow`.
6. Zoom state (legacy Z): active layer uses `setTransform(scale*dpr, 0, 0, scale*dpr, tx, ty)`; geometry stays in canvas space (2.8).

### 2.5 Commit Protocol (main -> render worker)

Legacy commit = flatten + append + notify `commited()`. Web commit must not flicker across two independently presented canvases:

```
commitShapes():
  1. ids = create[] ++ affect[]  (legacy order: create then affect; drawUnder: affect then create, inserted at log head)
  2. pack records into a CommitBatch: one transferable ArrayBuffer from the CommitPool (3.2.4)
  3. move records to pendingCommit[] (still drawn on active layer)
  4. postMessage({type:'commit', batchId, under:drawUnder}, [buffer])
  5. clear create[] and affect[] (arena slots recycled), call commited() on create module then active affects
render worker on 'commit':
  6. append records to CommittedLog, insert into SpatialGrid
  7. rasterize: if !under: draw each record onto committed canvas (O(vertices of batch));
                if under: mark tiles ∩ bbox dirty for replay (2.6)
  8. after the worker's next rAF presents, postMessage({type:'commitAck', batchId}, [emptiedBuffer])  (buffer returned to pool)
main on 'commitAck':
  9. drop pendingCommit records of batchId, mark active layer dirty
```

Invariant: a committed shape is always visible on exactly one of {active layer via pendingCommit, committed canvas}, except for at most the single frame where both show it (double draw is invisible for opaque shapes; for alpha < 255 a one-frame darker flash is possible, mitigated by acking only after `requestAnimationFrame` in the worker, which in Chromium and Firefox is synchronized with the main-thread compositor frame).

### 2.6 Scaling to Complex Drawings (render worker)

Goal: per-frame cost independent of total shape count N; mutation cost proportional to the affected area, not N.

**Committed raster.** One OffscreenCanvas at device resolution is the presentation surface. It is never fully re-rendered during interaction.

**Logical tile grid.** The device-pixel plane is divided into `T = 256` px tiles, `cols = ceil(Wdev/T)`, `rows = ceil(Hdev/T)`. Tiles are logical (clip rectangles), not separate bitmaps: zero extra GPU memory.

**SpatialGrid.** Per tile, an append-only `Uint32Array` list of shape ids in log order (growable chunk lists from a pool, 64 ids per chunk). Insert: shape bbox (device px, inflated by stroke half-width) -> tile range -> append id to each tile list. Removal (Limit, clear, baking): ids are tombstoned in a `Uint8Array alive[]`; tile lists are compacted lazily when tombstone ratio > 25%.

**Dirty-tile replay.** Any mutation of committed shape k (Random, Smooth, MicExpand, Limit removal, drawUnder insert) produces `dirty = tiles(oldBBox_k) ∪ tiles(newBBox_k)`. Replay job per tile:

```
ctx.save(); ctx.beginPath(); ctx.rect(tileRect); ctx.clip()
fill background color; draw background image region; draw baked base region (2.7)
for id in tileList[tile] (log order) where alive[id]: draw cached Path2D(id) with its paint
ctx.restore()
```

Scheduling: dirty tiles enter a `Uint16Array` queue (deduplicated by a `Uint8Array` bitmap). The worker processes tiles in its rAF until 4.0 ms elapsed, then yields. Unprocessed tiles keep their stale pixels (visually acceptable: the mutated shape is temporarily displayed at its old state in those tiles only). Priority: tiles containing the hover point first.

**Path2D cache.** Each committed shape owns one `Path2D` built once at commit from the command stream (allocation outside the main-thread hot path; worker GC pauses do not affect input latency). Rebuilt only when the shape is mutated. Evicted (set to null, rebuilt on demand) under an LRU of 20,000 entries.

**Hit testing (COMMITTED-domain affects).** Hover modules need "topmost committed shape containing p" (legacy walks newest to oldest with `path.contains`). Web: tile of p -> walk its list from newest to oldest -> bbox test -> `ctx.isPointInPath(path2d, x, y, winding)` (fill semantics, legacy `GeneralPath.contains` ignores stroke width; parity). Repeat uses bbox-only test inflated by 10 px (legacy). Cost O(shapes in one tile).

**Module domain split.** Modules declare `domain`:
- `ACTIVE`: operate on create/affect arenas on the main thread (Mirror, Displace, Gradient, ColorSwitcher, Blindness, all create modules).
- `COMMITTED`: operate on the committed log inside the render worker, driven by hover-sample batches (Random, Smooth, MicExpand, Limit). Repeat is `HYBRID`: hit test and clone happen in the worker; the clone geometry is returned to main and placed into `affect[]`.

This removes every legacy O(N) full redraw from the main thread.

**Full re-raster (rare).** Triggered by: resize to a larger backing size, DPR change, flip H/V, zoom toggle, smoothing pref change, background color change, clear-with-session-PDF overlay. Strategy: allocate new OffscreenCanvas at the new size, keep presenting the old bitmap scaled via `drawImage` as a placeholder, mark all tiles dirty, replay progressively with the 4 ms budget, swap when done. 50k shapes at ~0.02 ms each = 1 s spread over ~250 frames without blocking input.

**Main-thread fallback.** If `OffscreenCanvas` or `transferControlToOffscreen` is missing (very old engines), the same RenderCore runs on the main thread with a 2 ms per-frame replay budget. API identical; message passing becomes direct calls.

### 2.7 Retention Ceiling and Baking

Vector retention exists for SVG/PDF export and tile replay. Unbounded sessions need a ceiling.

| Threshold | Action |
|---|---|
| Committed vertices > 4,000,000 or shapes > 50,000 or estimated worker heap > 64 MB | Bake: oldest 50% of shapes by log index that are older than the undo horizon (8.5; excluding any shape referenced by an active COMMITTED-domain module) are rasterized into `bakedBase` (an OffscreenCanvas same size as committed), removed from the log, their arena space reclaimed by compaction |
| Export after baking | SVG embeds `bakedBase` as `<image href="data:image/png;base64,...">` at z-bottom; PDF embeds it as an image XObject. HUD export dialog flags "partially rasterized" |
| Clear | Drops log, grid, baked base |

### 2.8 View Transforms (Zoom, Flip)

Legacy mutates every committed shape's geometry for zoom and flip (O(N) and lossy). Web:

- Flip H/V: geometry is mutated (legacy parity: flip is a drawing operation, exported results are flipped). Executed in the worker as a single pass `x' = W - x` or `y' = H - y` over the vertex arena (tight `Float32Array` loop, ~4M vertices in ~10 ms), gradient endpoints included, then full re-raster (2.6). [LEGACY BUG] zoom applying horizontal gradient flip is not ported.
- Zoom (Z key, factor 4 about the pointer): view-only. A view matrix `V = [s,0,0,s,tx,ty]` with `s = 4`, `t = p_pointer * (1 - s)` is applied to all three canvases' transforms. Input samples are inverse-transformed `p_canvas = (p_screen - t)/s` before reaching modules, so modules never see zoom (removes legacy `calculateZoomedX` from Mirror). Committed canvas re-rasters at zoom (full re-raster path, clipped to visible tiles only).

### 2.9 Module Registry

Legacy: JPF plugin zips discovered in `./modules`, two extension points `Create` and `Affect`, two instances per class (sorted and unsorted), sort-order overrides, per-module enable pref.

Web: static, tree-shakeable registry. Each module is an ES module default-exporting a `ModuleDescriptor`; the registry is a literal array imported by the app shell. Heavy modules (TypeShapes, EvolveShapes, PitchShapes analysis, TraceShapes edge worker) are referenced via dynamic `import()` thunks so they become lazy chunks.

`ModuleDescriptor` fields:

| Field | Type | Meaning |
|---|---|---|
| `id` | string literal | stable id, e.g. `create.shapes` |
| `kind` | `'create' \| 'affect'` | extension point |
| `domain` | `'ACTIVE' \| 'COMMITTED' \| 'HYBRID'` | thread placement (2.6) |
| `order` | int | sort index (below) |
| `requires` | bitset | `MIC`, `PITCH`, `CAMERA`, `IMAGE`, `FONT`, `STAMPS` |
| `controls` | `ControlSpec[]` | HUD sub-toolbar (6.1) |
| `stateSize` | int | bytes of preallocated state block |
| `load` | `() => Promise<ModuleImpl>` | lazy implementation |

Default order. Affects: Displace 0, Gradient 1, Mirror 2, Blindness 3, Random 4, then (discovery order, 101+) ColorSwitcher, Limit, MicExpand, Repeat, Smooth. Creates: Shapes 0, MicShapes 1, SpeedShapes 2, then DetachShapes, EvolveShapes, InverseShapes, MedianShapes, PitchShapes, PressureShapes, PullShapes, RibbonShapes, ScrawlShapes, SplatterShapes, TraceShapes, TypeShapes, XShapes (alphabetical, legacy discovery order [UNKNOWN], alphabetical chosen).

Affect execution order = ascending `order` among active affects, both for event dispatch and `affect()` calls. Order matters: Displace mutates create shapes, then Gradient paints them, then Mirror clones them (clones inherit displaced geometry and gradient), Random then acts on committed shapes independently.

Per-module enable pref `alchemy.v1.modules.<id>` (default true). Disabled modules are hidden from the HUD and keyless.

### 2.10 Module Lifecycle Contract

| Hook | Called when | Thread |
|---|---|---|
| `setup()` | First selection (create) or first activation (affect). [LEGACY BUG] module 0 is marked loaded so `setup` runs once | module domain |
| `reselect()` | Later selections | same |
| `deselect()` | Create replaced, or affect unchecked. Must release mic/camera/timers | same |
| `cleared()` | Canvas cleared | same |
| `committed()` | After every commit | same |
| `affect()` | Affect only, once per tick when geometry changed (2.3 step 2) | ACTIVE only |
| `pointerDown/Move/Drag/Up/Cancel(sample)` | Per input sample; `Move` = buttons 0, `Drag` = buttons != 0 | same |
| `pointerClick(sample, count)` | Synthesized: up within 300 ms and 4 px of down; `count` from `PointerEvent.detail` (fallback own counter, 400 ms window) | same |
| `keyDown/keyUp(code, key, mods)` | Forwarded after global shortcuts (create first, then active affects) | main |
| `audio(level, block)` | Per tick when a mic-requiring module is active | main |
| `suspend()/resume()` | `visibilitychange` hidden/visible | same |

Dispatch to create precedes affects for all events (legacy). `events=false` (HUD shown and pointer inside it), `createEvents`, `affectEvents` flags gate dispatch (Mirror axis move sets `createEvents=false`).

### 2.11 Create Module State Machines

Common: `S` = current create shape (last record in `create[]`). "commit" = 2.5. All coordinates are canvas space after view inverse. Constants are legacy defaults.

| Module | Down | Drag | Up | Other |
|---|---|---|---|---|
| Shapes (freehand) | new shape at p; if `outline` and style FILL then shape style STROKE | `S.curveTo(p)` | `S.lineTo(p)`; restore FILL if outline; commit | Double click: reset guides, commit |
| Shapes (straight) | - | treated as Move | first click: new shape, `secondClick = (style==FILL)`; later clicks: `S.lineTo(p)`, guide segment kept in FILL mode for closing edge; `lastPt = p` | Move: guide line `lastPt -> p`, color (0,255,255) alpha 100, width 1; double click: reset + commit |
| SpeedShapes | new shape at p; `oldP = p` | `pt` per 5.3.1; `curveTo` if freeform else `lineTo`; `oldP = p` | commit | |
| PressureShapes | new empty shape, `S.spineTo(penLoc, w)` | `S.spineTo(penLoc, w)` | commit | `w` per 1.2 |
| MicShapes | shake: new shape at p; fatten: new empty, `spineTo(p, micLevel)`; `lastPt = p` | per 5.3.4 | shake: `lineTo(p)`; commit | mic opened on setup, closed on deselect |
| PitchShapes | new empty, `spineTo(p, weight)` | ease weight, `spineTo(p, weight)` | commit | analysis graph on setup, stopped on deselect |
| MedianShapes | capture mode: record control gesture; replay mode: two shapes (median, raw) | per 5.3.6 | capture -> replay; replay: control = this gesture | `cleared()`: back to capture |
| PullShapes | pick folder, stamp | stamp if `now - lastStamp >= gap` | commit | per 5.3.7 |
| RibbonShapes | new empty shape | if `now - time >= spacing`: commit, new shape, `time = now`; else update particles, rebuild path | reinit particles, commit | `cleared()`: reapply params |
| SplatterShapes | `start = end = p` | splat per 5.3.9 | commit | |
| TraceShapes | new shape at p | `S.curveTo(snap(p))` | commit | image ingest per 4.3 |
| ScrawlShapes | new shape at p, `oldP = p` | if `count % flow == 0`: scrawl, `oldP = p`; `count++` | commit | |
| InverseShapes | commit (ends hover shape) | - | `moveTo = true` | Move (buttons 0): first move new shape, then `curveTo(p)` |
| DetachShapes | `newPath = true` | tethered point per 5.3.12 | commit | tether `(x,y)` persists across strokes |
| XShapes | new shape at p, `oldP = null` | per 5.3.13, `lineTo` | commit | |
| TypeShapes | shuffle, stamp glyph at p with size `size*50`, commit | every 50 ms stamp with size from speed, commit each | - | Space: auto-generate cluster; keys if enabled |
| EvolveShapes | stamp random population shape | stamp if `now - last >= gap` | commit | Evolver dialog (6.1) |

### 2.12 Affect Module Pipeline

| Module | Domain | Hooks | Reads | Writes |
|---|---|---|---|---|
| Displace | ACTIVE | `affect()` while pointer down; Drag updates speed | `create[]` | `create[]` geometry in place (cumulative per tick) |
| Gradient | ACTIVE | `affect()` | `create[]`, `affect[]` | gradient slot of each record |
| Mirror | ACTIVE | `affect()`; Move/Up in axis-move mode | `create[]` | `affect[]` at fixed slots (5.4.1) |
| Blindness | ACTIVE | setup/reselect: `activeRender = false`; deselect: true + redraw; Up: reveal if autoReveal; key R | - | render flags |
| ColorSwitcher | ACTIVE | Down; Drag (if constant, every 50 ms) | canvas color | canvas color/alpha; `create[]`, `affect[]` color |
| Random | COMMITTED | hover batch (buttons 0) | committed hit shape | that shape's vertices |
| Smooth | COMMITTED | hover batch, throttled 75 ms, not while pen down | committed hit shape | replace path, or append new shape if `repeat` |
| MicExpand | COMMITTED | hover batch selects shape; audio ticks alter it every 50 ms while pointer up | committed hit shape, mic | shape vertices; removes shape when its bbox covers the viewport |
| Repeat | HYBRID | hover throttled `gap` ms; Down commits affect shapes if inside; key B | committed hit (bbox+10) | clone into `affect[]`; commit when outside for 3 consecutive hover evaluations |
| Limit | COMMITTED | after each commit and each tick with geometry change | counts | removes oldest committed shapes |

Mirror slot invariant: Mirror requires exclusive use of `affect[]` layout. [LEGACY BUG/UNKNOWN] other affect modules that append to `affect[]` (Repeat) corrupt Mirror's index math. Web: each affect module owns a private sub-range of `affect[]` (`affectRanges[moduleId]`), so slots never collide. Render order inside `affect[]` follows module order.

---

## 3. In-Memory Data Structures, State & Zero-Dependency Export

### 3.1 Input Ring (main thread)

Single-producer (event handlers) / single-consumer (`tick`). Preallocated, power-of-two, never grows.

`InputRing: Float32Array(CAP * STRIDE)`, `CAP = 4096`, `STRIDE = 8`, `mask = CAP - 1`, `head`, `tail` as uint32 counters.

| Offset | Field | Units / encoding |
|---|---|---|
| 0 | `x` | CSS px, canvas space before view inverse |
| 1 | `y` | CSS px |
| 2 | `t` | ms, `event.timeStamp` minus `epoch` (session start), float32 precision ~ 0.001 ms over 4.6 h |
| 3 | `pressure` | raw [0, 1] |
| 4 | `tiltX` | degrees |
| 5 | `tiltY` | degrees |
| 6 | `buttons` | integer bitmask stored as float |
| 7 | `meta` | bit-packed: bits 0-1 kind (0 mouse, 1 pen, 2 touch), bits 2-3 phase (0 move, 1 down, 2 up, 3 cancel), bit 4 coalesced, bit 5 predicted, bit 6 hardwarePressure, bits 8-15 pointerId slot |

Overflow (producer laps consumer, only possible if a tick stalls > ~1 s at 4 kHz rawupdate): drop oldest move samples, never drop down/up/cancel (phase samples are written to a separate 64-slot `phaseRing` with sequence numbers and merged by `t`).

Predicted samples (`getPredictedEvents`) go to a separate 16-slot `PredictRing`, overwritten every event, read only by the active-layer renderer to draw a provisional tail segment; never seen by modules and never committed.

### 3.2 Shape Memory Model (GC-free)

#### 3.2.1 Command Encoding

Path commands use a `Uint8Array` command stream with implicit vertex consumption:

| Code | Command | Vertices consumed (x,y pairs) |
|---|---|---|
| 0 | MOVE | 1 |
| 1 | LINE | 1 |
| 2 | QUAD | 2 (control, end) |
| 3 | CUBIC | 3 (c1, c2, end) |
| 4 | CLOSE | 0 |

#### 3.2.2 ActiveArena (main thread)

Preallocated at boot, sized for the worst case of one frame, recycled per commit.

| Buffer | Type | Capacity | Content |
|---|---|---|---|
| `vtx` | `Float32Array` | 2 x 65,536 | x, y interleaved |
| `cmd` | `Uint8Array` | 65,536 | command codes |
| `spine` | `Float32Array` | 4 x 16,384 | x, y, halfWidth, pressureEff |
| `edgeL` / `edgeR` | `Float32Array` | 2 x 16,384 each | incremental outline offsets (5.1.4) |
| `hdr` | `Int32Array` | 64 records x 24 | record headers |
| `hdrF` | `Float32Array` view on same buffer as `hdr` | | float fields |

Record header layout (stride 24 x 4 bytes):

| Slot | Field | Type | Notes |
|---|---|---|---|
| 0 | `id` | i32 | session-unique, monotonic |
| 1 | `vtxOff` | i32 | index into `vtx` pairs |
| 2 | `vtxCap` | i32 | reserved pairs (per-record region; default 4096) |
| 3 | `vtxCount` | i32 | |
| 4 | `cmdOff` | i32 | |
| 5 | `cmdCount` | i32 | |
| 6 | `spineOff` | i32 | -1 if no spine |
| 7 | `spineCount` | i32 | |
| 8 | `flags` | i32 | bit0 style FILL (else STROKE), bit1 evenodd, bit2 penShape, bit3 closed, bit4 hasGradient, bit5 underCommit, bit6 guide |
| 9 | `rgba` | i32 | packed 0xRRGGBBAA, alpha premultiplied into A only (legacy stores alpha inside color) |
| 10 | `lineWidth` | f32 | via `hdrF` |
| 11 | `totalPoints` | i32 | legacy counter driving curveTo warmup |
| 12-13 | `lastX, lastY` | f32 | legacy `lastPoint` (raw, not the emitted midpoint) |
| 14-17 | `bbMinX, bbMinY, bbMaxX, bbMaxY` | f32 | updated incrementally on vertex append |
| 18-21 | `gx1, gy1, gx2, gy2` | f32 | gradient endpoints |
| 22 | `gradientRgba2` | i32 | second stop (Gradient module: same RGB, alpha 0) |
| 23 | `ownerModule` | i32 | module index that created it (affect range ownership, 2.12) |

Allocation: `create[]` and `affect[]` are `Int32Array(64)` index lists into `hdr`. A free-list `Int32Array(64)` recycles header slots. Vertex regions are bump-allocated per record from `vtx` with `vtxCap = 4096` pairs; a record reaching its cap triggers split-commit (7.2). Arena reset happens when `create[]`, `affect[]` and `pendingCommit[]` are all empty.

Zero-allocation rules for the hot path: no closures created per sample, no array literals, no `{x,y}` objects (functions take and return through two module-level scratch `Float32Array(8)` registers), no string building, no `Path2D`, no `Array.prototype.map/forEach`, no template literals, no `Math.hypot` with spread. `Math.hypot(a, b)` is allowed (no allocation in V8/JSC/SM, but `sqrt(a*a+b*b)` preferred for speed).

#### 3.2.3 CommittedLog (render worker)

Chunked so growth never copies large buffers:

| Store | Type | Chunk | Content |
|---|---|---|---|
| `vtxChunks[]` | `Float32Array` | 1,048,576 floats (4 MB) | vertices |
| `cmdChunks[]` | `Uint8Array` | 524,288 | commands |
| `hdr` | `Int32Array` growable by doubling (max 50,000 x 24 x 4 = 4.8 MB) | | same layout as 3.2.2 plus slot 2 reused as `chunkIndex` |
| `alive` | `Uint8Array` | parallel to hdr | tombstones |
| `path2d[]` | `Array<Path2D \| null>` | | LRU cache (2.6) |
| `strokeGroup` | `Int32Array` | parallel | history op id that created the shape (8.5) |

Records never straddle chunks (a record that does not fit starts the next chunk). Compaction (after baking or > 25% tombstones) runs as a background job copying live records into fresh chunks, 2 ms slices.

#### 3.2.4 CommitPool and Message Schemas

`CommitPool`: 4 `ArrayBuffer`s of 1 MB each, ping-ponged via transfer. A CommitBatch buffer layout: `[u32 recordCount][records: header(24 x 4 B) | cmd bytes padded to 4 | vtx f32 pairs]...`. A batch larger than 1 MB is split. If the pool is exhausted (worker stalled), main allocates a new buffer (logged as a perf warning, never blocks drawing).

Main -> worker messages (all structured-clone-free except transfers):

| type | Payload | Transfer |
|---|---|---|
| `init` | OffscreenCanvas, dpr, size, prefs | canvas |
| `commit` | batchId, under flag, buffer | buffer |
| `hover` | `Float32Array` of (x, y, t, buttons) x n, active committed-module ids | buffer |
| `moduleParams` | moduleId, packed `Float32Array` params | buffer |
| `audio` | latest level + sample block for MicExpand | buffer |
| `clear`, `flip`, `zoom`, `resize`, `background`, `setImage(ImageBitmap)` | | ImageBitmap |
| `export` | format, scale, options | |

Worker -> main: `commitAck`, `repeatClone` (geometry buffer), `exportResult` (Blob), `stats`, `evolveSource` (normalized shapes).

When `crossOriginIsolated === true` (host sends COOP `same-origin` + COEP `require-corp`), hover and audio channels switch to `SharedArrayBuffer` rings with `Atomics.store` head counters, removing per-tick `postMessage`. This is an optimization, never a requirement (static hosts like GitHub Pages cannot set headers).

### 3.3 Persistence (localStorage)

Replaces `java.util.prefs`. Single JSON document per namespace, written debounced 500 ms after change and on `pagehide`. All reads wrapped in try/catch; absent or corrupt storage falls back to defaults. Key prefix `alchemy.v1.`; a `schema` integer enables forward migration.

| Key | Default | Legacy pref |
|---|---|---|
| `canvas.color` | `#000000`, alpha 255 | `Color` |
| `canvas.eraserColor` | `#FFFFFF`, alpha 255 | slot 1 |
| `canvas.background` | `#FFFFFF` | `Background Color` |
| `canvas.alphaLocked` | false | runtime |
| `canvas.style` | `STROKE` | runtime |
| `canvas.lineWidth` | 1 | runtime |
| `canvas.lineSmoothing` | true | `Line Smoothing` (AlcShape curve smoothing) |
| `canvas.drawUnder` | false | runtime |
| `swatch.colors` | [] (array of 0xRRGGBBAA) | swatch |
| `session.intervalMs` | 30000 (choices 500, 1000, 5000, 15000, 30000, 60000, 120000, 300000, 600000) | `Recording Interval` |
| `session.autoClear` | false | `Auto Clear Canvas` |
| `session.recordOnStart` | false | `Recording State` |
| `session.link` | true | `Link to Current Session` |
| `session.filePrefix` | `Alchemy-` | `Session File Pre Name` |
| `session.dateFormat` | `yyyy-MM-dd-HH-mm-ss` | `Session File Date Format` (formatted with a 30-line TS formatter, tokens yyyy MM dd HH mm ss) |
| `export.defaultFormat` | `png` | none |
| `export.scale` | 1 (choices 1, 2, 3, 4) | export dialog percent |
| `hud.mode` | `floating` (`floating` \| `docked`) | `Simple ToolBar` |
| `input.syntheticPressure` | true | none |
| `input.vMax`, `input.pMin`, `input.gamma` | 3.0, 0.15, 1.0 | none |
| `modules.<id>` | true | `Module - <name>` |
| `modules.active.create` | `create.shapes` | runtime |
| `modules.active.affects` | [] | runtime |
| `modules.params.<id>` | per ControlSpec defaults | runtime |
| `keys` | {} overrides `{actionId: {code, mods}}` | shortcut prefs |
| `locale` | `system` | `Locale` |

Dropped prefs: `Session Path`, `Export Directory`, `Shapes Path`, `Switch * Application`, `Palette/Canvas Location`, `Canvas Size`, `Transparent Fullscreen`, `Smoothing` (2.4). `Undo Depth` becomes `history.maxSteps` (8.5).

In-memory only (never persisted, cleared on reload): loaded custom SVG stamps (PullShapes), trace reference image and derived maps (TraceShapes), Evolve population, session PDF pages, loaded session PDF for draw-over. Optional post-MVP: IndexedDB for stamps (`alchemy-assets` store), off by default.

### 3.4 Export (zero dependency, worker-side)

All serializers run in the render worker (or compute worker for PDF) over the CommittedLog, so export of 50k shapes never blocks drawing. Output is a `Blob` transferred to main, downloaded via an object URL on a hidden `<a download>`, revoked after 10 s.

#### 3.4.1 SVG Serializer

Streaming: emits string fragments into an array of chunks (each <= 64 KB, joined by the `Blob` constructor, never one giant string).

```
<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<!-- Generated by Athanor (Alchemy web) -->
<rect width="100%" height="100%" fill="{bg}"/>                      (omitted if transparent export)
[<image href="data:image/png;base64,..." width W height H/>]        (baked base, 2.7)
<defs> linearGradient per gradient record </defs>
<path d="..." .../> per alive record in log order
</svg>
```

Rules:
- `d` from command stream: `M x y`, `L x y`, `Q cx cy x y`, `C ...`, `Z`. Numbers formatted with a fixed 2-decimal fast formatter (integer math, no `toFixed` allocation loop beyond the string itself), trailing zeros trimmed.
- STROKE: `fill="none" stroke="#rrggbb" stroke-opacity="a/255" stroke-width="w" stroke-linecap="round" stroke-linejoin="bevel"`.
- FILL: `fill="#rrggbb" fill-opacity="a/255" fill-rule="nonzero|evenodd"`.
- Gradient: `<linearGradient id="g{id}" gradientUnits="userSpaceOnUse" x1 y1 x2 y2><stop offset="0" stop-color="#rgb" stop-opacity="a1"/><stop offset="1" stop-color="#rgb" stop-opacity="0"/></linearGradient>`, referenced as `fill="url(#g{id})"` or `stroke=`. `spreadMethod="pad"` (legacy non-cyclic GradientPaint clamps).
- Coordinates in CSS px canvas space (resolution independent).

#### 3.4.2 PNG Export

Worker composes into a new `OffscreenCanvas(W*k, H*k)` with `setTransform(k,0,0,k,0,0)`, replays the log (or `drawImage` of committed canvas when k equals current dpr and no transparency requested), then `convertToBlob({type:'image/png'})`. Options: scale k in {1,2,3,4} (default = `devicePixelRatio`, capped so `W*k*H*k <= 16.7 Mpx` (Safari canvas area limit)), transparent background toggle (omits background fill; legacy PNG transparency). JPEG dropped from MVP (PNG covers the use case; `image/jpeg` is a one-line option post-MVP).

#### 3.4.3 PDF Writer (lazy chunk, target <= 6 KB gzipped)

Minimal PDF 1.4 writer, no fonts, no compression in MVP (optional `CompressionStream('deflate')` when available: content streams get `/Filter /FlateDecode`; feature-detected, async).

Object graph per document:

| Obj | Content |
|---|---|
| 1 | `/Catalog /Pages 2` |
| 2 | `/Pages /Kids [...] /Count n` |
| 3 | `/Info /Title (Alchemy Session) /Creator (Athanor) /CreationDate (D:yyyyMMddHHmmss)` |
| per page | `/Page /MediaBox [0 0 W H] /Contents c /Resources << /ExtGState << ... >> /Shading << ... >> /XObject << ... >> >> /Group << /S /Transparency /CS /DeviceRGB >>` |
| per page content | operators below |
| per alpha value | `/ExtGState << /ca a /CA a >>` deduplicated by alpha byte (max 256) |
| per gradient | Type 2 axial shading with `/Extend [true true]`; soft mask `/SMask << /S /Luminosity /G formXObject >>` where the form paints a white-to-black axial shading; then fill/stroke the path with color 1 (legacy iText strategy: fade to transparent, second color ignored) |
| baked base | `/XObject /Image` RGB 8-bit, raw or Flate |

Content stream: initial `1 0 0 -1 0 H cm` (flip to top-left origin), background `re f`, then per record: `/GSn gs`, `r g b rg` or `RG`, `w w`, `1 J` (round cap), `2 j` (bevel join), path ops `x y m`, `x y l`, quad converted to cubic (`c1 = p0 + 2/3 (c - p0)`, `c2 = p + 2/3 (c - p)`), `x1 y1 x2 y2 x3 y3 c`, `h`, paint `f` / `f*` / `S`.

Xref built from byte offsets tracked while emitting (UTF-8 bytes counted via ASCII-only output). Multi-page session: pages are stored as independent serialized page objects (content bytes + resources) in memory; `save` assembles the full document. Memory cap: 200 pages or 64 MB of page data, oldest pages flushed to a forced download first (user warned).

#### 3.4.4 Clipboard Copy

`navigator.clipboard.write([new ClipboardItem({'image/png': pngBlobPromise, 'image/svg+xml': svgBlobPromise})])`. The promise form is required for Safari (user-activation must be held synchronously). `image/svg+xml` is included only when `ClipboardItem.supports?.('image/svg+xml')` is true; otherwise PNG only.

---

## 4. Browser I/O, Web Audio & Asset Ingestion Contracts

### 4.1 Microphone (replaces `AlcMicrophone`)

#### 4.1.1 Permission Flow

| State | Trigger | Next | UI |
|---|---|---|---|
| `IDLE` | mic module setup/activation (user gesture: module selection click or key) | `REQUESTING` | HUD module chip shows spinner |
| `REQUESTING` | `getUserMedia({audio:{echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:1}})` resolves | `RUNNING` | level meter in sub-toolbar |
| `REQUESTING` | rejects `NotAllowedError` | `DENIED` | toast: "Microphone blocked"; module stays selected, uses level 0 (draws as if silent) |
| `REQUESTING` | rejects `NotFoundError` | `NODEVICE` | same, different message |
| `RUNNING` | `visibilitychange` hidden | `SUSPENDED` | `audioContext.suspend()`, tracks kept |
| `SUSPENDED` | visible | `RUNNING` | `resume()` (requires prior gesture, already granted) |
| `RUNNING` | last mic module deselected | `IDLE` | stop all tracks (frees OS mic indicator), `close()` the context after 2 s idle |

One shared `AudioContext({latencyHint:'interactive'})` and one `MediaStreamAudioSourceNode` for all mic modules (MicShapes, MicExpand, PitchShapes).

#### 4.1.2 Level Pipeline (AudioWorklet)

`LevelProcessor` (AudioWorkletProcessor, ~1 KB, loaded from a Blob URL so it ships inside the main bundle):

Per render quantum (128 frames, float samples `f` in [-1, 1]):
```
s16_i     = clamp(round(f_i * 32767), -32768, 32767)        (legacy 16-bit domain)
meanAbs   = (1/128) * sum |s16_i|
legacyLvl = meanAbs / 100                                   (legacy getMicLevel range 0..327.68)
rms       = sqrt((1/128) * sum f_i^2)
zcr       = count(sign(f_i) != sign(f_{i-1})) / 128
```
Accumulates over a window `Wq` quanta (default `Wq = 4`, i.e. 512 frames = 10.7 ms at 48 kHz), then posts `{legacyLvl, rms, zcr, peak}` plus the last 512 int16 samples (for MicShapes shake and MicExpand wave) into:
- SAB ring (64 slots x 520 floats) when `crossOriginIsolated`, else
- `port.postMessage` with a recycled transferred `Float32Array` (pool of 8 buffers returned by main).

Main thread reads only the latest slot each tick (older blocks are discarded: drawing samples audio at frame rate, as legacy did at buffer rate).

Legacy MicExpand buffer sizing (`2*(totalPoints+1|2)` bytes) is replaced by "take the first `segmentCount` samples of the latest 512-sample block, wrapping modulo 512" ([LEGACY BUG] out-of-bounds when segments exceed samples is fixed by wrap).

`AnalyserNode` fallback: if `audioWorklet` is unavailable, an `AnalyserNode` with `fftSize = 512` and `getFloatTimeDomainData` into a preallocated `Float32Array(512)` per tick computes the same metrics on the main thread.

#### 4.1.3 MicShapes `buf[0]` Parity

Legacy shake reads the first raw signed byte of the buffer (`buf[0]`, the high or low byte of sample 0 depending on endianness, range -128..127). Web: `b0 = s16_0 >> 8` (high byte, signed). [UNKNOWN] legacy endianness on the author's hardware; high byte chosen (it carries signal; low byte is noise-like).

#### 4.1.4 Pitch Estimation (PitchShapes)

Legacy: Beads FFT on 2048-sample frames, hop 777, power spectrum, 10 strongest spectral peaks `(freq_k, energy_k)`, `pitch = sum(freq_k * energy_k) / sum(energy_k)`, only when `energy_0 > 1000`.

Web contract:
- `AnalyserNode` `fftSize = 2048`, `smoothingTimeConstant = 0`, `minDecibels = -100`, `maxDecibels = 0`; connected to the shared source; read with `getFloatFrequencyData(Float32Array(1024))` every tick at most every 16 ms (hop parity ~ 777/44100 = 17.6 ms).
- Power per bin: `P_b = 10^(dB_b / 10)`; `freq_b = b * sampleRate / 2048`.
- Peak picking: bins `b in [2, 1022]` with `P_b > P_{b-1}` and `P_b >= P_{b+1}`; keep the 10 largest (fixed-size insertion into a 10-slot `Float32Array` pair, no sort allocation). Parabolic interpolation per peak: `delta = 0.5*(a - c)/(a - 2b + c)` on dB values, `freq = (b + delta) * sr / 2048`.
- Energy gate: legacy threshold 1000 is in Beads' unnormalized power units [UNKNOWN scale]. Web gate: `P_peak0 > gateLin` with `gateLin = 10^(-50/10)` (-50 dBFS), exposed as an advanced control.
- `pitch = sum(freq_k * P_k) / sum(P_k)`.
- Optional higher-accuracy mode (pref): YIN on the 2048 time-domain block in the worklet (threshold 0.15), used only if the user selects "Voice (precise)". Not in MVP critical path.

#### 4.1.5 Timing Model

Legacy mic thread called modules from a non-UI thread with no synchronization (races on shape paths). Web: audio data is only consumed inside `tick` on the main thread or inside the render worker's rAF (MicExpand), never concurrently. MicExpand's 50 ms alteration gap is evaluated against `frameTime`.

### 4.2 Pointer Sampling & Smoothing

#### 4.2.1 Listener Topology

All listeners on the canvas host `<div>` (not `window`), `{passive: true}` except `pointerdown` (needs `setPointerCapture`) and the iOS touch guard (6.3).

| Event | Handler |
|---|---|
| `pointerdown` | `setPointerCapture(pointerId)`; write phase sample; write `getCoalescedEvents()` is not applicable (down has none) |
| `pointerrawupdate` (if `'onpointerrawupdate' in window`; Chromium, Firefox) | write all `getCoalescedEvents()` samples (or the event itself if the list is empty); mark `rawActive = true` |
| `pointermove` | if `rawActive`, only read `getPredictedEvents()` into PredictRing; else write coalesced samples + predicted |
| `pointerup` | write coalesced tail (Chromium can coalesce into up), phase sample |
| `pointercancel`, `lostpointercapture` | phase cancel: create module treats as `Up` (commit, never discard) |

Coalesced event handling: each coalesced event provides its own `offsetX/Y`, `pressure`, `tilt`, `timeStamp`. Coalesced lists are iterated with an index loop; the returned array is the only allocation per event, owned by the browser and unavoidable (it is short-lived, young-generation, and occurs at event rate, not per sample). Measured cost is negligible relative to frame budget; documented as the single accepted allocation source in the input path.

#### 4.2.2 Delta Time and Velocity

For velocity modules (SpeedShapes, XShapes, ScrawlShapes, TypeShapes, Splatter, synthetic pressure):

```
dt   = t_i - t_{i-1}   (ms; samples with dt <= 0 are kept for geometry but get dt = 1 for rates)
dx   = x_i - x_{i-1}, dy = y_i - y_{i-1}
vTaxi = |dx| + |dy|            (legacy "speed" metric, per-event, not per-ms)
vEuc  = sqrt(dx*dx + dy*dy) / dt
```

Legacy modules measure speed per event, which depends on event rate (JPen 200 Hz, AWT mouse ~60-125 Hz). Coalesced high-rate input (up to 1000 Hz on gaming mice and 240 Hz on Apple Pencil) would shrink per-event deltas and change the look. Parity strategy: **event-rate normalization**. A resampler feeds modules at a fixed nominal rate `R_mod = 120 Hz`:

```
accumulate raw samples; emit a module sample whenever t - tLastEmit >= 1000/R_mod (8.33 ms),
with x,y = latest raw sample, pressure/tilt = max/mean over the accumulated window
pointerdown/up are always emitted immediately
```

Modules marked `rateSensitive` (Speed, X, Scrawl, Splatter, Type, Displace, Median) receive resampled input. Geometry-accurate modules (Shapes, Pressure, Trace, Inverse, Detach, Mic, Pitch, Pull, Evolve, Ribbon) receive every raw coalesced sample (their output is distance-gated by `curveTo`/`spineTo`, so extra samples only add fidelity). `R_mod` is a pref (60 to 240).

#### 4.2.3 Pressure Smoothing

Hardware pressure is noisy at high sample rates. One-pole low-pass on `pressureEff`: `p_s = p_s + k*(p - p_s)`, `k = 1 - exp(-dt / tau)`, `tau = 12 ms`. Disabled for synthetic pressure (already smoothed).

### 4.3 Asset Ingestion

#### 4.3.1 Sources

| Asset | Sources | Parser | Destination |
|---|---|---|---|
| SVG stamp (PullShapes) | `drop` on canvas, `<input type=file accept=".svg,image/svg+xml" multiple>`, paste (`clipboardData` text/html containing `<svg>`) | 4.3.2 in compute worker | `StampLibrary` user folder |
| Trace image | drop, file input `accept="image/*"`, paste image, webcam frame | `createImageBitmap(file, {imageOrientation:'from-image'})` | render worker (display) + compute worker (maps) |
| Session PDF to draw over | Not in MVP (requires a PDF renderer, too heavy). [DIVERGENCE] Replaced by "load image as background" which accepts PNG/JPEG/WebP and, if the browser can rasterize it via `<img>`, SVG | | |
| Swatch import (`.gpl`, `.ase`) | file input | GPL: text lines `R G B name`; ASE: big-endian binary blocks `0x0001` color entries, model `RGB ` floats | swatch store |

Drop handling: `dragover` `preventDefault` on the canvas host; `drop` inspects `dataTransfer.files` by MIME and extension; SVG and image types routed accordingly; anything else ignored with toast. Max file size 20 MB (SVG) / 50 MB (image).

#### 4.3.2 SVG Stamp Parser (pure TS, ~3 KB)

- Parse with `DOMParser` (`image/svg+xml`) in main thread is not available in workers; therefore parse text directly in the compute worker with a minimal tokenizer that extracts `<path d>`, `<polygon points>`, `<polyline points>`, `<rect>`, `<circle>`, `<ellipse>`, `<line>`, and `transform` attributes (`matrix`, `translate`, `scale`, `rotate`, `skewX/Y`) along the ancestor chain. `<use>`, CSS, text, filters, masks ignored.
- Path data grammar: commands `M m L l H h V v C c S s Q q T t A a Z z`, implicit repeats, exponent numbers. Relative to absolute conversion. `S/T` reflect previous control point. Arcs converted to cubics via endpoint-to-center parameterization (SVG 1.1 F.6.5) split into segments of <= 90 degrees, `k = 4/3 * tan(dtheta/4)`. Circles/ellipses as 4 cubics with `k = 0.5522847498`.
- Output: one stamp per file = union of all subpaths in one command/vertex buffer (fill rule `nonzero`; `evenodd` if the root or path declares `fill-rule="evenodd"`).
- Normalization: translate bbox to origin, keep native size (legacy PullShapes used native PDF size then scaled by `random(0.1, size)`).
- Bundled stamps: legacy `shapes/{Bones,Circles,Parts,Tanagram}` PDFs are converted once at build time (offline script, not shipped) into `stamps.json`: `{folders:[{name, stamps:[{cmd:base64, vtx:base64 Float32, w, h}]}]}`, loaded lazily on PullShapes setup (~20-40 KB gzipped, outside the 40 KB initial budget). [UNKNOWN] Tanagram folder content was not inspected beyond listing; included as-is.

#### 4.3.3 Webcam Trace Source

`getUserMedia({video:{width:{ideal:1280}, facingMode:'user'}})` -> hidden `<video>` -> `requestVideoFrameCallback` (fallback rAF) -> at most 15 Hz, `createImageBitmap(video)` transferred to compute worker -> maps rebuilt (4.3.4). "Freeze" button stops updates (snapshot mode, default after 1 capture to save power). Stream tracks stopped on TraceShapes deselect or `visibilitychange` hidden.

#### 4.3.4 Trace Maps (compute worker)

On every new trace image:
1. Fit to canvas visible rect: `s = min(W/w, H/h)`, size `(round(w*s), round(h*s))`, centered `((W-nw)/2, (H-nh)/2)` (legacy `setImage` parity). Drawn at device resolution onto an OffscreenCanvas, `getImageData` once.
2. Brightness map `B: Uint8Array(nw*nh)`, legacy formula `B = idiv(222R + 707G + 71B, 1000)` (AlcUtil.getColorBrightness).
3. Optional edge map `E: Uint8Array` = Sobel magnitude of B, `|Gx| + |Gy|` clamped to 255 (used by the "edge snap" web mode).
4. Maps transferred back to main (`ArrayBuffer` transfer, ~2 MB at 1280x720), where `checkSnap` runs in the hot path (5.5).

Display: the scaled `ImageBitmap` goes to the render worker as background image when "Display Image" is on.

---

## 5. Mathematical & Algorithmic Specifications

All formulas are legacy-exact unless marked. Float math is IEEE-754 double in JS; vertex storage is float32. Where legacy used `int` truncation, `int()` is applied (parity matters for golden tests).

### 5.0 PRNG and Noise (replaces `java.util.Random`, `AlcMath`)

**PRNG**: `mulberry32` (32-bit state, period 2^32, ~1 ns/call, no allocation).
```
next(): s = (s + 0x6D2B79F5) | 0; t = imul(s ^ (s >>> 15), 1 | s); t = (t + imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296            in [0, 1)
random(h)     = h == 0 ? 0 : h * next()        (legacy re-rolls when v == h; float32 parity irrelevant in float64, v < h guaranteed)
random(a, b)  = a >= b ? a : a + random(b - a)
gauss()       = Box-Muller with cached second value (two state slots, no allocation)
```
Streams: one PRNG per module (seeded from session seed XOR hash(moduleId)) so toggling modules does not perturb others' sequences (test determinism). Session seed = `crypto.getRandomValues(Uint32Array(1))` at boot; overridable by URL `?seed=`.

**Noise** (`AlcMath.noise`, Processing-style value noise, legacy-exact):
```
PERLIN_SIZE = 4095; YWRAPB = 4 (YWRAP 16); ZWRAPB = 8 (ZWRAP 256)
perlin[4096] = noisePRNG.next() each         (built once per noiseSeed; legacy rebuilt sin/cos LUT per call: fixed)
cosLUT[720]  = cos(i * 0.5 deg)              (built once at module load)
fade(t)      = 0.5 * (1 - cosLUT[int(t * 360) % 720])
octaves = 4, falloff = 0.5, amp0 = 0.5; negative inputs -> abs()
noise(x,y,z):
  xi,yi,zi = int parts; xf,yf,zf = fractions; r = 0; amp = amp0
  repeat octaves:
    of = xi + (yi << 4) + (zi << 8)
    rxf = fade(xf); ryf = fade(yf)
    n1 = perlin[of & 4095];       n1 += rxf * (perlin[(of+1) & 4095] - n1)
    n2 = perlin[(of+16) & 4095];  n2 += rxf * (perlin[(of+17) & 4095] - n2);  n1 += ryf * (n2 - n1)
    of += 256
    n2 = perlin[of & 4095];       n2 += rxf * (perlin[(of+1) & 4095] - n2)
    n3 = perlin[(of+16) & 4095];  n3 += rxf * (perlin[(of+17) & 4095] - n3);  n2 += ryf * (n3 - n2)
    n1 += fade(zf) * (n2 - n1)
    r += n1 * amp; amp *= falloff
    xi <<= 1; xf *= 2; yi <<= 1; yf *= 2; zi <<= 1; zf *= 2
    if xf >= 1: xi++, xf--   (same for y, z)
  return r                                    range [0, 0.9375)
```

**Utilities**: `map(v,a,b,c,d) = c + (d - c) * (v - a)/(b - a)`; `constrain`; `distance = sqrt(dx^2 + dy^2)`; `mean(int[]) = idiv(sum, n)` (integer division parity, used by XShapes).

### 5.1 Shape Construction Primitives (`AlcShape`)

Constants: `startPoints = 5`, `minDistance = 5`, `minDistanceSpine = 3`. `lineSmoothing` = pref `canvas.lineSmoothing` (default true). Each record tracks `totalPoints` and `last` (raw last accepted point).

#### 5.1.1 `newShape(p)`
`cmd = [MOVE p]`, `totalPoints = 1`, `last = p`, attributes from canvas (color with current alpha, style, lineWidth, `lineWidth < 0 -> 0`).

#### 5.1.2 `curveTo(p)` (quadratic midpoint smoothing)
```
if !lineSmoothing: lineTo(p); return
if p == last: return                                   (exact float equality)
if totalPoints < 5: emit LINE p; accept(p); return
if distance(p, last) > 5:
    m = ((last.x + p.x)/2, (last.y + p.y)/2)
    emit QUAD (ctrl = last, end = m); accept(p)        (last := raw p, not m)
accept(p): totalPoints++, last = p, flags.penShape = 1
```
Geometric meaning: the curve passes through midpoints of consecutive accepted samples using each sample as control point, which is a uniform quadratic B-spline through the sample polygon. C1-continuous. The tail between the last midpoint and `last` is closed by the final `lineTo` on release.

#### 5.1.3 `lineTo(p)`
Same equality filter; `totalPoints < 5` -> emit LINE; else emit LINE only if `distance(p, last) > 5`. With `lineSmoothing = false`, LINE is emitted unconditionally (after the equality filter) [UNKNOWN: legacy lineTo gating when smoothing off is identical to the smoothing-on gating in source reading; spec keeps the gating in both cases].

#### 5.1.4 Spine to Variable-Width Outline (`spineTo`, `createSpine`, `rightAngle`)

```
rightAngle(p1, p2, d):  a = atan2(p1.y - p2.y, p1.x - p2.x) - pi/2
                        return (p1.x + d*cos a, p1.y + d*sin a)

spineTo(p, w):  requires penLocationChanged (sample is a new location)
  if spine empty: push (p, w)
  else if distance(p, spine[last]) > 3: push (p, w); rebuild()
```
Outline (closed polygon, widths are half-width offsets on one side only; the spine itself is one edge for the first point):
```
O_0      = spine[0]
O_i      = rightAngle(spine[i], spine[i-1], w_i)                for i = 1..n-1     (outer side, walking forward)
I_k      = rightAngle(spine[k-1], spine[k], w_k)                for k = n-1..1     (inner side, walking backward)
path     = newShape(O_0); curveTo(O_1..O_{n-1}); curveTo(I_{n-1}..I_1); CLOSE
```
Since `rightAngle(a, b)` rotates the direction `b -> a` by -90 degrees, outer points sit at `+90` of the forward tangent and inner points at `+90` of the backward tangent, i.e. on opposite sides of the spine at distance `w`. Total ribbon width at spine vertex i is `2 * w_i` (outer at `w_i` one side, inner at `w_i` other side), tapering to zero at `spine[0]`.

**Web optimization (exact parity, O(1) per sample instead of O(n))**: legacy rebuilt the whole outline on every spine point. Web stores raw offsets incrementally:
- `edgeL[i] = O_i` computed once when spine point i arrives (depends only on i, i-1).
- `edgeR[k] = I_k` computed once when spine point k arrives (depends only on k-1, k).
- The emission pass (`curveTo` chain over `O_1..O_{n-1}, I_{n-1}..I_1`) runs once per tick (not per sample) when the spine changed, writing into the record's cmd/vtx region from the start. Cost O(n) per frame, bounded by the 4096-vertex split cap. Output is bit-identical to legacy because the gating chain is replayed in the same order.

#### 5.1.5 Smooth Kernel (`Smooth` affect, `EvolveShapes` mutate)
Input: end points of each segment of the shape (`getPoints`: MOVE, LINE end, QUAD end, CUBIC end), `P_0..P_{n-1}`.
```
emit MOVE P_0
for i in 1..n-2:
   s_i = 0.25 P_{i-1} + 0.5 P_i + 0.25 P_{i+1}
   m_i = (P_{i-1} + s_i) / 2
   emit QUAD (ctrl = P_{i-1}, end = m_i)
emit LINE P_{n-1}
winding = nonzero
```
Evolve uses only the in-place 3-tap pass `P_i <- 0.25 P_{i-1} + 0.5 P_i + 0.25 P_{i+1}` (endpoints fixed), sequential (uses already-updated `P_{i-1}`; legacy in-place parity).

#### 5.1.6 Catmull-Rom (web extension, not legacy)
Available to the resampler as an optional "Ink" smoothing pref (off by default to preserve the Alchemy look): centripetal Catmull-Rom (`alpha = 0.5`) through accepted samples, converted to cubic Beziers: `c1 = P1 + (P2 - P0)/(6 tau)`, `c2 = P2 - (P3 - P1)/(6 tau)` with `tau = 1` for uniform; centripetal uses knot spacing `t_{i+1} = t_i + |P_{i+1} - P_i|^0.5`.

### 5.2 Transforms

| Op | Formula |
|---|---|
| Translate | `p' = p + (dx, dy)` |
| Scale about origin | `p' = (sx x, sy y)` |
| Rotate about bbox center c | `p' = c + R(theta)(p - c)`, `R = [[cos,-sin],[sin,cos]]` |
| Normalize (Evolve) | `s = 100 / max(bbW, bbH)`; `p' = s (p - bbMin)` |
| Fit image | `s = min(W/w, H/h)`, size `round(w s) x round(h s)`, offset `((W - nw)/2, (H - nh)/2)` |

All applied by one `applyAffine(vtx, off, count, a,b,c,d,e,f)` loop over the Float32Array region: `x' = a x + c y + e`, `y' = b x + d y + f`.

### 5.3 Create Module Algorithms

#### 5.3.1 SpeedShapes
Defaults: `multiplier = 15` (slider 0-35), `freeform = true`.
```
speed = idiv(|p.x - oldP.x| + |p.y - oldP.y|, 2)     (int)
theta = atan2(p.y - oldP.y, p.x - oldP.x)
pt    = (int(p.x + speed*multiplier*cos theta), int(p.y + speed*multiplier*sin theta))
freeform ? curveTo(pt) : lineTo(pt)
```

#### 5.3.2 PressureShapes
`w = penKind == CURSOR ? 1 : pressureEff * pressureAmount`, `pressureAmount` default 25 (spinner 1-200). `spineTo(penLoc, w)`.

#### 5.3.3 PitchShapes
Defaults `minWeight 1`, `maxWeight 50`, `minPitch 50`, `maxPitch 1800`.
```
pitch in (minPitch, maxPitch): pn = 1 - (pitch - minPitch)/(maxPitch - minPitch); target = (maxWeight - minWeight) pn + minWeight
pitch >= maxPitch: target = minWeight;  pitch <= minPitch: target = maxWeight
per drag sample: weight += sign(target - weight) * min(2, |target - weight|)
spineTo(penLoc, weight)
```
[LEGACY BUG] upper-pitch slider was wired to the lower slider's listener; web wires each slider to its own variable.

#### 5.3.4 MicShapes
`micLevel = legacyLvl * 2`; `volume = slider * 0.02` (slider 0-100, default 50 -> 1.0).
- Fatten: `w = max(1, micLevel * volume)`; `spineTo(p, w)`.
- Shake: `lvl = b0 == 0 ? micLevel : b0 * micLevel` (b0 per 4.1.3); `pt = rightAngle(p, lastPt, lvl * volume)`; `curveTo(pt)`; `lastPt = p`. On up: `lineTo(p)`.

#### 5.3.5 ScrawlShapes
Defaults `flow 10` (1-25), `detail 10` (2-50), `noise 10` (1-50); `count` persists across strokes (legacy, never reset).
```
xStep = idiv(p2.x - p1.x, steps); yStep = idiv(p2.y - p1.y, steps)       (int math)
px = p1.x; py = p1.y   (ints)
for i in 0..steps-2:
   px = int(px + xStep + random(-noise, noise)); py = int(py + yStep + random(-noise, noise))
   curveTo((px, py))
```

#### 5.3.6 MedianShapes
State: `control[]` (Float32Array pairs, cap 4096 points), `buffer[]`, `pointCount`, `capture = true`.
- Capture gesture: normal freehand (curveTo), recording raw points into `control`.
- Replay gesture, down at p: `m = (p.x - idiv(p.x - c0.x, 2), p.y - idiv(p.y - c0.y, 2))`; create median shape at m and raw shape at p; `buffer[0] = p`.
- Drag: `pointCount++`; if `pointCount < len(control)`: `m = p - idiv(p - control[pointCount], 2)` per axis; median shape `curveTo(m)`. Raw shape `curveTo(p)`; `buffer[pointCount] = p`.
- Up: `control = buffer` (swap buffers, no allocation), commit.
Correspondence is by sample index, not arc length (legacy). With event-rate normalization (4.2.2) index correspondence becomes time correspondence at `R_mod`, which is the legacy intent.

#### 5.3.7 PullShapes
Defaults: `gap = 1 + 2*spacing` (spacing 0-100, default 25 -> 51 ms), `size = 0.1 + v/10` (v 1-50, default 20 -> 2.1) [LEGACY: initial field 2.0, UI default 20 maps to 2.1; web uses 2.1], `rotate = true`, `scale = true`.
```
folder = selected; if "All": folder = int(random(nFolders))
stamp  = folder.stamps[int(random(n))]
s      = random(0.1, size); scale(s, s)
theta  = rotate ? random(0.1, 57.2958) : 0      (radians; legacy units are radians, value range wraps ~9 turns: equivalent to U[0, 2pi) visually)
rotate about bbox center; translate so bbox center = p
attributes from canvas (color, alpha, style, lineWidth)
```

#### 5.3.8 RibbonShapes
Particle chain `n = 20` points per ribbon, 1 ribbon. Params: `size` 1-100 (default 50) -> `radiusMax = size`, `radiusDivide = (100 - size)/5`; `friction = v * 0.01` (1-200, default 110 -> 1.10); `gravity = v * 0.01` (0-200, default 15 -> 0.15); `maxDistance = 40`; `drag = 2`; `dragFlare = 0.015`; `randomness = 0.2`; `spacing` 1-100 ms (default 25).

Particle state SoA `Float32Array(20 * 12)`: `px, py, xSpeed, ySpeed, radius, leftX, leftY, rightX, rightY, lc2x, lc2y, rc2x` (+ `rc2y` in a second array).

Per accepted drag sample (not on spacing-commit samples):
```
push (x, y) as new particle at tail (shift left when n reached; ring index instead of shift in web)
for i in 1..n-2 (prev = i-1, next = i+1):
   c1 = (prev + p)/2; c2 = (next + p)/2; d = c2 - c1; theta = atan2(d.y, d.x); dist = |d|
   if dist > maxDistance:
       delta = (maxDistance/drag) (cos theta, sin theta); p += delta; speed += delta * dragFlare
   ySpeed += gravity; speed *= friction; p += speed + (random(0.3), random(0.3))
   p += (randomness/2 - random(randomness)) * dist     (per axis, independent draws)
   r = i > n/2 ? dist / radiusDivide : radius[next] * 0.9      (radius[next] from previous frame)
   r = min(r, radiusMax); if i == 1 or i == n-2: r = min(r, 1)
   left = p + r (cos(theta + 3pi/2), sin(theta + 3pi/2)); right = p + r (cos(theta + pi/2), sin(theta + pi/2))
   lc2 = (left[next] + left)/2; rc2 = (right[next] + right)/2
path (replaces record geometry each update):
   MOVE lc2[1]
   for i in 2..n-5:   CUBIC (left[i], lc2[i], lc2[i])
   for i in n-4..2:   CUBIC (right[i], rc2[i-1], rc2[i-1])
   CLOSE
```
Note `friction > 1` amplifies speed (legacy default 1.10): ribbons are deliberately unstable and short-lived, reset by spacing commits. Commit cadence: `now - time >= spacing` commits the current shape and starts a new empty one; `time` initial 0 makes the first drag commit immediately (parity). Ribbon is continuous: physics run on each sample only (legacy), no idle animation.

#### 5.3.9 SplatterShapes
`influence = map(v, 1, 100, 0, 2)` (v default 50 -> 0.98990), `maxLineWidth = random(50) + 50` (once per setup), `drips` 0-50 default 10, `size` initial = influence (legacy sets both).
```
mid   = start + (end - start) * 1.5        (from previous segment, before update)
start = end; end = p
dist  = |end - start| (1 if 0)
size  = influence * (maxLineWidth / dist) + (1 - influence) * size
main stroke: newShape(start), lineWidth = max(0, size), QUAD (mid, end)          (emitted raw, bypassing curveTo gating)
splotch = |end - start|
i = 0; while i < drips/4 + random(0, drips):        (bound re-rolled each iteration, legacy)
   o4 = splotch * (random(1) - 0.5, random(1) - 0.5)
   o5 = (random(1) - 0.5, random(1) - 0.5)
   dd = max(0, size * (0.5 + random(1)))
   drip: newShape(start + o4), lineWidth = dd, curveTo(start + o4 + o5)
   i++
```
Splatter strokes are always rendered STROKE with round caps, so a 1-segment drip renders as a dot of diameter `dd`. Influence > 1 makes `(1 - influence) < 0`: oscillating width (legacy behavior, kept).

#### 5.3.10 InverseShapes
Hover draws: first move after up creates `newShape(p)`, later moves `curveTo(p)`. Pointer down commits. Touch has no hover: [DIVERGENCE] on `pointerType touch`, InverseShapes draws while touching and commits on a second-finger tap (otherwise unusable).

#### 5.3.11 TraceShapes snap
Defaults `halfArea 30` (1-100), `tolerance 100` (0-200).
```
q = p - imageOffset; if q outside image: return p
b0 = B[q]
best = -1; bestPt = p
for y in [max(0, q.y - halfArea), min(h, q.y + halfArea)), x likewise:
   d = |B[x,y] - b0|
   if d > tolerance and d > best: best = d; bestPt = (x, y) + imageOffset
return bestPt
```
Cost `(2 halfArea)^2` = up to 40,000 reads per sample at halfArea 100. Web acceleration (exact result): a per-tile summary `maxB[tile]`, `minB[tile]` with tile 16x16. A tile is skipped when `max(|maxB - b0|, |minB - b0|) <= max(tolerance, best)`. Typical speedup 10-50x on photos. Scan order row-major, ties resolved to the first found (legacy parity: strict `>`).
Brightness `B = idiv(222R + 707G + 71B, 1000)` (legacy `getColorBrightness`).
Optional "Edge" mode (web extension): maximize Sobel `E` within the window instead of `|B - b0|`, threshold = tolerance.

#### 5.3.12 DetachShapes (tether)
DetachShapes: tether state `(x, y)` init (100, 100), `distance` 0-300 default 100.
```
theta = atan2(p.y - y, p.x - x); x = p.x - cos(theta) distance; y = p.y - sin(theta) distance
pt = (int x, int y); first sample of stroke: newShape(pt), else curveTo(pt)
```

#### 5.3.13 XShapes
`multiplier = idiv(v, 2)` (v 0-100, default 50 -> 25).
```
speed = mean of last 10 taxicab speeds (ring buffer Int32Array(10), integer mean)     [LEGACY BUG fixed: legacy list grew unbounded]
pts   = totalPoints * 0.01
d     = pts + speed / 2                     (speed int, /2 float)
theta = atan2(oldP.y - p.y, oldP.x - p.x) - pi/2
pt    = oldP + (d * multiplier) (cos theta, sin theta)
lineTo(pt)
```

#### 5.3.14 TypeShapes
State: `scale` int [2,5], `doubleScale = 2 scale`, `explode` int [1,4], `noisiness = random(0.00001, distortion)`, `distortion = v * 0.01` (0-100, default 50), `noiseScale` accumulates, `size = 0.1 + v/10` (1-50, default 20 -> 2.1).
Glyph acquisition (web, no font parser): render `letter` with `ctx.font = "{px}px {family}"` into a compute-worker OffscreenCanvas at 1 px/unit with 4 px padding, threshold alpha >= 128, trace contours with marching squares (16-case table, saddle cases resolved by center average), simplify with Ramer-Douglas-Peucker epsilon 0.75 px, keep the first (outer) contour, truncate to 50 segments (legacy first subpath, <= 50 segments).
Font families: `queryLocalFonts()` when available and permitted (Chromium, user prompt on first use), else the fixed list `serif, sans-serif, monospace, cursive, fantasy, system-ui` plus families detectable via `document.fonts.check`.
```
mess(f): noiseScale += noisiness; return (noise(noiseScale) * doubleScale - scale) * f      (applied to each coordinate of MOVE/LINE/QUAD; CUBIC copied)
placement: at p (pointer), or random in [0, W) x [0, H) (keys)        [LEGACY BUG fixed: legacy used W for both axes]
auto letter offset: (random(-(W >> explode), W >> explode), random(-(H >> explode), H >> explode))
rotate by random(0.3, 6.0) rad
pointer size: down = int(size * 50) px; drag = (|dx| + |dy|) * size px, every 50 ms
generate (Space): iterations int(random(5, 12)); glyphs placed with explode offsets; union computed by rasterizing all glyphs into one mask and tracing it once (exact union, replaces legacy Area boolean ops that threw OutOfMemoryError); translate to (random(W), random(H)); not committed until next commit (legacy)
```

#### 5.3.15 EvolveShapes
Population = normalized committed shapes (5.2 normalize to 100), zero-size removed. Stamp: clone `pop[int(random(n))]`, scale `s = penKind == CURSOR ? 1 : pressureEff * 2`, rotate `atan2(oldPen.y - pen.y, oldPen.x - pen.x)`, center at p. Gap `1 + 2 v` ms (v 0-100) [LEGACY: initial 51 vs UI default 5 -> 11; web uses UI default 11].

Breeding (`breed(s1, s2, mix)`):
```
wind(P) = sign( sum_i x_i (y_{i+1} - y_{i-1}) / 2 )   (cyclic)
if wind(s1) != wind(s2): reverse P2
N = round(n1 mix + n2 (1 - mix))
for i in 0..N-1:
   i1 = floor(map(i, 0, N-1, 0, n1-1)); i2 = floor(map(i, 0, N-1, 0, n2-1))
   q_i = P1[i1] + (P2[i2] - P1[i1]) (1 - mix)
polyline MOVE q_0, LINE q_1..q_{N-1}
```
Mutation (`mutation` in [0,1], default 0.5):
```
rate = int(map(mutation, 0, 1, 50, 0))^2
each point: if int(random(rate)) == 0: p += (random(-w/2, w/2), random(-h/2, h/2))
smoothPasses: k = 0; while k < int(random(int(map(mutation, 0, 1, 1, 35)))): 3-tap pass (5.1.5); k++
```
Generation step: sort by user rank ascending (stable sort; [LEGACY BUG] inconsistent comparator fixed), pair adjacent ranked shapes `(i, i+1)` with any rank > 0: `child = breed(s_i, s_{i+1}, r_i/(r_i + r_{i+1}))`; fill the rest by breeding the last child with random members (`mix = random(1)`) then mutating; if nothing ranked, mutate all. Reset ranks, normalize, shuffle (Fisher-Yates on PRNG). Runs in compute worker.

### 5.4 Affect Module Algorithms

#### 5.4.1 Mirror (axis reflection)
Axes: vertical axis at `a` (x), horizontal axis at `b` (y), default `a = idiv(W, 2)`, `b = idiv(H, 2)`. Toggles: `horizontal` (default on, reflect across x = a), `vertical` (off, reflect across y = b).
```
H(p)  = (2a - x, y)          matrix [-1 0 2a; 0 1 0]
V(p)  = (x, 2b - y)          matrix [1 0 0; 0 -1 2b]
HV(p) = (2a - x, 2b - y)     point reflection through (a, b)
slots per create shape i: H -> i*k, V -> i*k + (horizontal ? 1 : 0), HV -> i*k + 2
k = shapeCount = (horizontal ? 1 : 0) + (vertical ? 1 : 0) + (horizontal && vertical ? 1 : 0)
```
Per tick, for each create record i: copy its cmd stream unchanged, transform vertices with the matrix into the owned affect slot (spine shapes: transform spine and re-emit outline, which yields identical geometry to transforming the outline since reflection preserves distances; web transforms the outline directly, O(n), no re-emit), copy attributes, transform gradient endpoints [LEGACY BUG fixed: legacy only reflected gradient on first clone].
Note: reflection reverses orientation (det = -1). With `nonzero` fill a single closed contour fills identically; spec keeps `nonzero`.
Axis move mode: `createEvents = false`, commit, crosshair guide follows pointer (cyan, alpha 100, width 1), next pointerup sets `(a, b) = p` in canvas space (zoom-correct by construction, 2.8), then `createEvents = true`. Reset: center.

#### 5.4.2 Random (committed jitter)
`distortion` 1-100 default 50; range `[-0.15 v, 0.15 v)` = `[-7.5, 7.5)` default. `proximity = 5`.
```
on hover p (buttons 0, every hover sample, no throttle):
  k = topmost committed shape containing p (2.6 hit test)
  for each segment s of k (by command):
     test point t = LINE: end; QUAD: end (pts[2], pts[3]); CUBIC: second control point (pts[2], pts[3]); MOVE/CLOSE: none
     near(t) = |int(t.x) - int(p.x)| < 5  OR  |int(t.y) - int(p.y)| < 5          (cross-shaped band, legacy OR)
     if near: every coordinate of the segment += U[lo, hi)   (independent per coordinate)
  mark tiles(oldBB ∪ newBB) dirty
```
Uniform distribution (legacy). Web option "Gaussian" (pref): `N(0, 0.15 v / 2)` per coordinate, clamped to +-3 sigma.

#### 5.4.3 Displace (active push)
`displacement` 1-15 default 7. On each drag sample: `speed = displacement - (|dx| + |dy|)` (taxicab, per resampled event, 4.2.2). Persisted across strokes (legacy).
```
affect(), while pointer down, for each create record:
   L = last vertex of path
   for each vertex v (spine vertices if spine exists, else MOVE/LINE/QUAD vertices; CUBIC untouched):
       theta = atan2(v.y - L.y, v.x - L.x); v += speed (cos theta, sin theta)
   spine records: re-emit outline (5.1.4)
```
Cumulative: applied once per tick in which geometry changed (legacy: once per redraw, i.e. per event). With per-tick application the push rate depends on frame rate; parity mode: apply `nEvents` times per tick where `nEvents` = resampled drag events processed this tick (default on).

#### 5.4.4 Smooth
Throttle 75 ms on hover, not while pointer down. Target = topmost hit committed shape. `repeat = false`: replace geometry with 5.1.5 output. `repeat = true`: append a new committed shape with the smoothed geometry and default attributes (legacy did not copy color; [DIVERGENCE] web copies the source shape's attributes, since default-black copies on colored drawings look like a bug).

#### 5.4.5 Repeat
`gap = 2 v + 50` ms (v 0-100, default 50 -> 150 ms), `repeat` on, `margin 10`, size tolerance 10.
```
hover throttled by gap:
  k = newest committed shape whose bbox (inflated by 10 when currently inside) contains p
  if k: outside = 0; if repeat: stamp(k, p)
  else: outside++; if outside == 3: commit; update = true
stamp(k, p): B = int bbox(k)
  if grab unset or |B.w - size.w| + |B.h - size.h| > 10 or update: size = B.size; offset = p - B.origin; update = false
  clone k translated by p - (B.origin + offset) into owned affect range
pointerdown: if outside <= 2: commit affect shapes; update = true
key B: toggle repeat
```

#### 5.4.6 Limit
`limit` 1-100 default 10.
```
total = committedAlive + |create| + |affect|
if total > limit and committedAlive > 0:
   r = total - limit; end = r > committedAlive ? committedAlive - 1 : r
   remove oldest max(1, end) committed shapes (end == 0 -> remove 1)
```
Removal tombstones and dirties tiles (2.6).

#### 5.4.7 ColorSwitcher
`baseRange` 0-100 default 50; base color HSB `(h0, s0, b0)` captured at setup or via picker.
```
half = (baseRange / 100) / 2
per channel c in {h, s, b}: lo = c0 - half; hi = c0 + half
   if lo < 0: hi += -lo; lo = 0  else if hi > 1: lo -= hi - 1; hi = 1
   c = random(lo, hi)
color = hsbToRgb(h, s, b)  (Java HSB: h in [0,1) wraps, standard hexcone)
alpha = int(random(255))     (range 0..254, legacy)
```
Fires on every pointerdown; with `constant` also every 50 ms during drag. Applies the new color (and alpha) to all create and affect records.

#### 5.4.8 Gradient
For each create and affect record:
- pen-drawn (`penShape` flag; set by `curveTo/lineTo/spineTo` accept): spine exists -> `g1 = spine[0]`, `g2 = spine[floor(n/2)]`; else `g1 = first MOVE`, `g2 = last vertex`. Recomputed every tick.
- other records (stamps, glyphs): once, `g1, g2 = (random(bx, bx + bw), random(by, by + bh))` each, fixed thereafter.
- Paint: linear, color stop 0 = record RGBA (including alpha [UNKNOWN: legacy getColor includes alpha; yes, web includes]), stop 1 = same RGB alpha 0, pad spread.

#### 5.4.9 MicExpand
`waveVolume = v * 0.0003`, `levelVolume = v * 0.001` (v 0-100, default 50). Mode `wave` (default) or `level`. Gap 50 ms. Active only while pointer up and hovering a committed shape; selecting a new shape re-arms.
- Wave: segment j uses sample `s16[j mod 512]`, `d = s * waveVolume`; for MOVE, LINE and both QUAD points: `theta = atan2(cur.y - v.y, cur.x - v.x)`, `v += d (cos theta, sin theta)` (toward the cursor for positive samples). [LEGACY BUG] legacy loop moved only the first two coordinates pairs due to a `pts.length/2` bound; web moves every point of MOVE/LINE/QUAD; CUBIC unchanged (parity).
- Level: `s = 0.9 + legacyLvl * levelVolume`; scale about bbox center `c`: `v' = c + s (v - c)`.
- Removal: if the shape bbox contains the whole viewport rect, the shape is removed and expansion stops.

#### 5.4.10 Blindness
Legacy: `setRedraw(false)` stops every repaint (buffer and active shapes); `forceRedraw()` paints once. Web equivalent:
- While active, the active layer is not rendered and the committed canvas is hidden (`visibility: hidden`); commits still happen normally in the worker.
- Reveal (button, key `R`, or pointerup when `autoReveal`, default on): committed canvas becomes visible until the next pointerdown.
- Deselect: both layers visible, full active redraw.
- No timers.

### 5.5 Hit Testing Geometry
`isPointInPath` with record winding; bbox prefilter. Legacy `GeneralPath.contains` uses the path's winding rule (nonzero) and ignores stroke width; strokes (open paths) are tested as implicitly closed polygons (Java and Canvas agree on this).

---

## 6. Web UI State Machines, Shortcuts & Viewport Matrix

### 6.1 HUD Component Hierarchy

Framework: Preact 10 + `@preact/signals` (~5.5 KB gz combined). HUD state lives in signals; the engine never imports UI code. Engine to UI: a typed `EngineBus` (fixed set of signal setters). UI to engine: command functions (`setLineWidth(n)`, `selectCreate(id)`, ...). Styling: one static CSS file (no CSS-in-JS runtime), custom properties for theme, `@layer hud`. All controls are native elements (`<button>`, `<input type=range>`, `<input type=number>`, `<select>`, `<dialog>`, `popover` attribute where supported with a JS fallback), giving keyboard access and screen-reader roles for free.

```
<Hud state=HIDDEN|PEEK|SHOWN|KEYED|DOCKED>
  <MainBar role="toolbar" aria-label="Alchemy">        (Tab flips to SwatchBar)
    SwatchFlipButton
    StyleToggle            (S)           aria-pressed
    UnderOverToggle        (D)           label Over/Under
    LineWidthStepper       1..75 step 1  ([ / ])
    Separator
    CreateMenu  popover    radio group of create modules, key hints 1..0, Alt+1..
    AffectMenu  popover    checkbox group of affect modules, key hints Mod+1..
    Separator
    ZoomToggle             (Z)
    ClearButton            (Mod+Backspace)
    SessionButton  popover Save Page, Save & Clear, Record toggle, Interval select, Auto Clear, Restart, Download PDF
    ExportButton   dialog  PNG / SVG / PDF, scale, transparency, Copy
    MenuButton     popover Settings, Shortcuts, Load background image, Unload, Flip H/V, Fullscreen, About
    DockToggle
  <SwatchBar role="toolbar">
    SwatchMenu popover     Clear swatch, Set background, Modulate dialog, Repeat modulation, Import (.gpl/.ase), Export (.gpl/.ase)
    AlphaLockToggle
    AlphaSlider            0..255 (default 255) [legacy initial 254 is a cosmetic bug; web 255]
    ColorButton            primary click: color picker slot 0; secondary/long-press: slot 1 (eraser)
    SwatchAdd / SwatchRemove
    SwatchStrip            roving tabindex, arrows reorder with Alt
  <SubBar role="region">   one <ModuleSection> per active module, create first then affects (ascending order)
    ModuleSection(title, controls: ControlSpec[])
  <Toasts aria-live="polite">
  <Dialogs> ColorPicker, ModulateSwatch, Shortcuts editor, Settings, Evolver, Export
```

Overflow: when SubBar exceeds viewport width, affect sections collapse to icon chips from the highest index backwards, then the create section (legacy rule). Chips expand into a popover on click.

ColorPicker: HSV square (canvas 160x160, drawn once per hue change) + hue strip + alpha strip + hex input + swatch row. No third-party picker. The legacy ColourLovers palette fetch is dropped (network) [DIVERGENCE]; a bundled set of 24 curated palettes replaces it.

### 6.2 Module Control Specs

`ControlSpec = {id, kind: slider|stepper|toggle|button|select|file, label, min, max, step, default, apply: 'release'|'live', bind, key?}`. Legacy sliders apply on release (`!getValueIsAdjusting`); web keeps `apply: 'release'` for parameters that rebuild state (Ribbon, Splatter) and uses `'live'` elsewhere (input events are cheap), marked below.

| Module | Control | Kind | Range | Default | Bind | Apply |
|---|---|---|---|---|---|---|
| Shapes | Line Type | toggle | | freehand | `straightShapes` | live |
| Shapes | Outline | toggle | | off | `outlineMode` | live |
| SpeedShapes | Line Type | toggle | | curves | `freeform` | live |
| SpeedShapes | Speed | slider | 0-35 | 15 | `multiplier` | live |
| PressureShapes | Pressure | stepper | 1-200 step 1 | 25 | `pressureAmount` | live |
| MicShapes | Draw Mode | toggle | fatten/shake | fatten | `shake` | live |
| MicShapes | Volume | slider | 0-100 | 50 | `volume = v*0.02` | live |
| MicShapes | Level meter | readout | | | `legacyLvl` | |
| PitchShapes | Current Pitch | readout | 50-1800 Hz | | `pitch` | |
| PitchShapes | Lower Pitch | slider | 50-1800 | 50 | `minPitch` | live |
| PitchShapes | Upper Pitch | slider | 50-1800 | 1800 | `maxPitch` | live |
| PitchShapes | Gate | slider (advanced) | -90..-20 dBFS | -50 | `gateDb` | live |
| PullShapes | Folder | select | bundled + "My stamps" + All | All | `currentFolder` | live |
| PullShapes | Add stamps | file | .svg multiple | | ingest | |
| PullShapes | Spacing | slider | 0-100 | 25 | `gap = 1 + 2v` | live |
| PullShapes | Size | slider | 1-50 | 20 | `size = 0.1 + v/10` | live |
| PullShapes | Rotate | toggle | | on | `rotate` | live |
| RibbonShapes | Size | stepper | 1-100 | 50 | `radiusMax, radiusDivide` | release |
| RibbonShapes | Spacing | stepper | 1-100 ms | 25 | `spacing` | release |
| RibbonShapes | Friction | slider | 1-200 | 110 | `friction = v*0.01` | release |
| RibbonShapes | Gravity | slider | 0-200 | 15 | `gravity = v*0.01` | release |
| SplatterShapes | Size | stepper | 1-100 | 50 | `influence = map(v,1,100,0,2)` | release |
| SplatterShapes | Drips | stepper | 0-50 | 10 | `drips` | live |
| TraceShapes | Display Image | toggle | | off | `imageDisplay` | live |
| TraceShapes | Load Image | file | image/* | | ingest | |
| TraceShapes | Camera | toggle | | off | webcam | live |
| TraceShapes | Freeze | button | | | snapshot | |
| TraceShapes | Snap Distance | slider | 1-100 | 30 | `halfArea` | live |
| TraceShapes | Tolerance | slider | 0-200 | 100 | `tolerance` | live |
| TraceShapes | Snap Mode | select | brightness/edge | brightness | `mode` | live |
| ScrawlShapes | Flow | slider | 1-25 | 10 | `flow` | live |
| ScrawlShapes | Detail | slider | 2-50 | 10 | `steps` | live |
| ScrawlShapes | Noise | slider | 1-50 | 10 | `noise` | live |
| DetachShapes | Distance | slider | 0-300 | 100 | `distance` | live |
| XShapes | Distance | slider | 0-100 | 50 | `multiplier = idiv(v,2)` | live |
| TypeShapes | Distortion | slider | 0-100 | 50 | `distortion = v*0.01` | live |
| TypeShapes | Auto-generate | button | | | `generate()` (Space) | |
| TypeShapes | Size | slider | 1-50 | 20 | `size = 0.1 + v/10` | live |
| TypeShapes | Key Drawing | toggle | | off | `keys` | live |
| TypeShapes | Use local fonts | button | | | `queryLocalFonts()` | |
| EvolveShapes | Evolver | button | | | open dialog | |
| EvolveShapes | Spacing | slider | 0-100 | 5 | `gap = 1 + 2v` | live |
| MedianShapes, InverseShapes | (none) | | | | | |
| Mirror | Horizontal | toggle | | on | `horizontal` | live |
| Mirror | Vertical | toggle | | off | `vertical` | live |
| Mirror | Move axis | button | | | axis move mode | |
| Mirror | Reset | button | | | center axes | |
| Random | Distortion | slider | 1-100 | 50 | `+-0.15 v` | live |
| Random | Distribution | select | uniform/gaussian | uniform | | live |
| MicExpand | Volume | slider | 0-100 | 50 | `wave 0.0003v, level 0.001v` | live |
| MicExpand | Mode | toggle | wave/level | wave | `wave` | live |
| Displace | Displacement | slider | 1-15 | 7 | `displacement` | live |
| Smooth | Repeat | toggle | | off | `repeat` | live |
| Repeat | Repeat | toggle (B) | | on | `repeat` | live |
| Repeat | Interval | slider | 0-100 | 50 | `gap = 2v + 50` | live |
| Limit | Number | stepper | 1-100 | 10 | `limit` | live |
| ColorSwitcher | Transparency | toggle | | on | `switchAlpha` | live |
| ColorSwitcher | Base Color | toggle + picker | | on | `switchColor`, base HSB | live |
| ColorSwitcher | Range | slider | 0-100 | 50 | `baseRange` | live |
| ColorSwitcher | Constant | toggle | | off | `constantColor` | live |
| Blindness | Reveal | button (R) | | | reveal | |
| Blindness | Auto-reveal | toggle | | on | `autoReveal` | live |
| Gradient | (none) | | | | | |

Evolver dialog (`<dialog>` modal): grid of population thumbnails (each a 100x100 `<canvas>`, drawn once per generation), rank stepper 0-100 per cell (`aria-label="Rank shape n"`), Mutation slider 0-100 (default 50, live), buttons Canvas (reload from committed), Import SVG (replaces legacy PDF), Evolve, Close. Thumbnails rendered by the compute worker into `ImageBitmap`s, painted with `transferFromImageBitmap` on `bitmaprenderer` contexts (zero main-thread rasterization).

### 6.3 Viewport Lock

| Concern | Mechanism |
|---|---|
| Scroll / pan | `html, body { overflow: hidden; overscroll-behavior: none; position: fixed; inset: 0 }` |
| Touch gestures on canvas | `#stage { touch-action: none }` (pointer events then deliver all touches) |
| iOS Safari pinch zoom on page | viewport meta `width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover` plus a non-passive `touchstart`/`touchmove` listener on `#stage` that calls `preventDefault()` when `touches.length > 1` (iOS ignores `user-scalable=no` since iOS 10), and `gesturestart` `preventDefault` |
| Double-tap zoom | `touch-action: none` covers it; `manipulation` on HUD buttons |
| Text selection | `#stage, #hud { user-select: none; -webkit-user-select: none }` except inputs |
| Callout / magnifier (iOS long press) | `-webkit-touch-callout: none; -webkit-tap-highlight-color: transparent` |
| Context menu | `contextmenu` `preventDefault()` on `#stage` (right button reaches modules as `buttons & 2`; legacy only used button 1 for drawing, right button is ignored by create modules) |
| Drag ghost of canvas | `draggable=false`, `dragstart` `preventDefault()` on stage |
| Pen barrel button | `buttons & 2` with `pointerType pen`: ignored for drawing (avoids context menu strokes) |
| Pointer capture | `setPointerCapture` on down so strokes continue outside the window; `lostpointercapture` = cancel = commit |
| Safe areas | HUD padded with `env(safe-area-inset-*)`; canvas covers full viewport including notch |
| Wake | Optional `navigator.wakeLock.request('screen')` while session recording is on |

### 6.4 Browser Event-to-Action Matrix

| Event | Target | Condition | Action | Legacy equivalent |
|---|---|---|---|---|
| `pointerdown` | stage | primary, button 0 or pen tip or touch | capture; phase sample; HUD -> HIDDEN unless DOCKED; module `pointerDown` (via tick) | `mousePressed` |
| `pointerdown` | stage | eyedropper armed | sample pixel, set color, disarm; not forwarded | eyedropper |
| `pointerdown` | stage | zoom-pick armed | zoom at p; not forwarded | zoom pick |
| `pointerdown` | stage | non-primary touch | gesture recognizer; commit active stroke | none |
| `pointerrawupdate` / `pointermove` | stage | any | coalesced samples to InputRing; predicted to PredictRing; HUD proximity update | `mouseMoved/Dragged` |
| `pointerup` | stage | primary | phase sample; module `pointerUp`; Blindness autoReveal | `mouseReleased` |
| `pointercancel` | stage | | treated as up (commit) | none |
| `lostpointercapture` | stage | stroke active | treated as up | none |
| `click` (synthesized) | | | module `pointerClick(count)` (Shapes double click commit) | `mouseClicked` |
| `keydown` | document | shortcut match, not in text input | action; `preventDefault` | key bindings |
| `keydown` | document | no match | forward to create then affects `keyDown` | `keyPressed` |
| `keyup` | document | | forward `keyUp` (TypeShapes Space/keys, Blindness R) | `keyReleased` |
| `blur` (window) | | stroke active | synthesize cancel -> commit; clear held-modifier state | none |
| `visibilitychange` hidden | document | | commit active shapes; suspend mic (`audioContext.suspend`), stop webcam updates, pause session timer (elapsed time preserved), pause rAF (automatic), flush prefs | none |
| `visibilitychange` visible | | | resume mic/session timer; full active redraw | none |
| `pagehide` | window | | flush prefs; if session has unsaved pages, nothing can be awaited: pages stay in memory only if bfcache restores, otherwise lost [UNKNOWN acceptable]; `beforeunload` prompt only when session pages > 0 | exit save |
| `resize` / ResizeObserver | stage | size or dpr changed | debounce 100 ms for backing reallocation; during the debounce, CSS-scale the existing canvases; then resize protocol below | window resize |
| `matchMedia('(resolution: Xdppx)')` change | | dpr changed (monitor move, browser zoom) | same as resize with new dpr | none |
| `dragover` / `drop` | stage | files | ingest (4.3) | file choosers |
| `paste` | document | image or svg | ingest | none |
| `fullscreenchange` | document | | keyboard lock on/off; resize protocol | fullscreen |
| `devicechange` (mediaDevices) | | mic in use | re-acquire default input | none |

Resize protocol (committed bitmap preservation):
1. New backing size `(Wd', Hd')`. Committed backing size is `max(previous, new)` per axis (never shrinks during a session), so shrinking a window loses nothing and re-growing shows prior content. The visible viewport is a sub-rect; CSS size equals viewport, the canvas element is sized to the viewport and the worker keeps a larger internal OffscreenCanvas `store`, blitting `store -> presentation` on change (one `drawImage`, GPU).
2. If dpr changed: full re-raster from the vector log at the new dpr (2.6), placeholder = old bitmap scaled.
3. Active and guide canvases simply reallocate (they are transient).
4. Mirror default axes are not moved on resize (legacy computed them on setup/reset only).

---

## 7. Testing Vectors, Performance Guardrails & Sandbox Replacements

### 7.1 Deterministic Unit Test Vectors

Harness: Vitest in Node (no DOM) for geometry; geometry functions are pure over typed arrays, so tests construct an ActiveArena, feed synthetic `InputSample` streams `(x_i, y_i, t_i, pressure_i)` and fixed mic blocks, then assert the record's `cmd` codes and `vtx` Float32 values with tolerance `1e-4` (float32 rounding). PRNG seeded with `seed = 1`. Expected values below are hand-derived from section 5 formulas.

**T1 Shapes curveTo warmup and gating** (lineSmoothing on)
Input: down (0,0) t=0; drags (10,0) t=8, (20,0) t=16, (30,0) t=24, (40,0) t=32, (42,0) t=40, (50,0) t=48, (60,5) t=56; up (61,5) t=64.
Expected cmd: `M L L L L Q Q`; vtx: `(0,0) (10,0) (20,0) (30,0) (40,0) (40,0)(45,0) (50,0)(55,2.5)`. `(42,0)` rejected (distance 2 <= 5). Up `lineTo(61,5)` rejected (distance 1 <= 5). `totalPoints = 7`, `last = (60,5)`.

**T2 SpeedShapes** (multiplier 15, freeform off)
down (0,0); drag (10,0); drag (10,10).
Sample 1: speed = idiv(10,2) = 5, theta 0, pt = (85, 0). Sample 2: speed 5, theta pi/2, pt = (int(10 + 75 cos(pi/2)), 85) = (10, 85).
Expected cmd `M L L`, vtx `(0,0) (85,0) (10,85)`.

**T3 Spine outline** (PressureShapes path, lineSmoothing on)
spineTo((0,0), w=4), ((10,0), 4), ((20,0), 4) (each > 3 px apart, location changed).
O_1 = rightAngle((10,0),(0,0),4) = (10,-4); O_2 = (20,-4); I_2 = rightAngle((10,0),(20,0),4) = (10,4); I_1 = rightAngle((0,0),(10,0),4) = (0,4).
Expected cmd `M L L L L Z`, vtx `(0,0) (10,-4) (20,-4) (10,4) (0,4)` (all LINE: totalPoints 1..4 < 5 during emission).

**T4 Mirror** W=800, H=600, horizontal+vertical on, k = 3. Create record vertex (100,50).
Expected affect slots: slot 0 `(700,50)`, slot 1 `(100,550)`, slot 2 `(700,550)`.

**T5 Displace** displacement 7. Create record vtx `(0,0) (10,0)`, cmd `M L`. Drag delta (1,1) -> speed = 5. One affect application.
Anchor L = (10,0). v0: theta = atan2(0, -10) = pi -> (-5, 0). v1 (anchor): theta = atan2(0,0) = 0 -> (15, 0).
Drag delta (3,4) -> speed 0 -> no change.

**T6 Smooth kernel** points (0,0),(10,10),(20,0).
s_1 = (10, 5); m_1 = (5, 2.5). Expected `M(0,0) Q(0,0, 5,2.5) L(20,0)`.

**T7 DetachShapes** tether (100,100), distance 100.
drag (300,100): theta 0 -> tether (200,100), pt (200,100) -> `M(200,100)`.
drag (300,300): theta = atan2(200,100) = 1.1071487; tether = (300 - 44.72136, 300 - 89.44272) = (255.27864, 210.55728); pt (255,210) -> `L(255,210)` (totalPoints 1 < 5).

**T8 ScrawlShapes** detail 10, noise forced 0 (test-only override; random(-0,0) returns lo = 0), flow 10, count 0.
down (0,0); drag (100,50) (count 0 -> scrawl). xStep 10, yStep 5. Expected 9 points `(10,5) (20,10) ... (90,45)` -> cmd `M L L L L Q Q Q Q Q` with Q gating: totalPoints reaches 5 after (40,20); (50,25) distance from (40,20) = 11.18 > 5 -> Q(ctrl (40,20), end (45,22.5)); subsequent Q ends (55,27.5) (65,32.5) (75,37.5) (85,42.5).

**T9 Mic level parity** samples int16 `[1000, -1000, 500, -500]` repeated over the 512 window.
meanAbs = 750, legacyLvl = 7.5. MicShapes fatten micLevel = 15, volume 1.0 -> w = 15. Level-mode MicExpand scale `s = 0.9 + 7.5 * 0.05 = 1.275`.

**T10 Pitch mapping** pitch 925 Hz, min 50, max 1800, weights 1..50 -> pn = 0.5, target = 25.5. From weight 1, after drags: 3, 5, ..., 25, 25.5 (13 steps).

**T11 ColorSwitcher window** base B channel 0.9, range 50 -> half 0.25, lo 0.65, hi 1.15 -> shifted lo 0.5, hi 1.0.

**T12 Trace snap** synthetic 5x5 brightness map all 100 except (4,4) = 255; halfArea 3; tolerance 100; p = (2,2) -> window [0,5)x[0,5); |255-100| = 155 > 100 -> returns (4,4) + offset. Tolerance 160 -> returns p.

**T13 Noise golden** `noiseSeed(1)`, `noise(0.5, 0, 0)`, `noise(12.3, 4.5, 0)`: expected values are frozen from the reference TS implementation at first green run and stored in `__golden__/noise.json` (cannot be hand-derived; regression guard).

**T14 Ribbon / Splatter / Type / Evolve** randomized modules: golden snapshots of `cmd`+`vtx` (hash + first 32 floats) with seed 1 and a fixed 60-sample spiral input `p_i = (400 + 3i cos(0.2i), 300 + 3i sin(0.2i))`, `t_i = 8.33 i`.

**T15 Resampler** raw 1000 Hz line samples over 100 ms -> exactly 12 module samples (t = 0, 8.33, ..., 91.6) + up; rateSensitive modules produce identical output for 125 Hz and 1000 Hz raw streams of the same path (within 1 px).

**Render golden tests** (Playwright, Chromium headless): draw scripted strokes, read committed canvas `getImageData`, compare against stored PNGs with per-pixel tolerance 2/255 and max 0.1% differing pixels (AA differences across GPUs). Export tests: SVG output parsed with DOMParser, path count and `d` equality; PDF output re-parsed by a 200-line test-only xref reader (validates offsets and object count); PNG dimensions = `W*k x H*k`.

**Performance tests** (Playwright + CDP `Performance.getMetrics` and tracing):
- 10 s synthetic 240 Hz pen stroke with Mirror+Gradient active: p99 tick duration < 6 ms on reference hardware (M1 / mid-range 2022 laptop), zero major GC events on main thread during the stroke (trace `V8.GC_MARK_COMPACTOR` count = 0; minor scavenges <= 1 per second).
- 50,000 committed shapes: tick p99 unchanged (+/- 0.5 ms) versus empty canvas; Random hover over dense area: worker replay <= 4 ms/frame, main-thread tick unaffected.
- Export SVG of 50,000 shapes completes < 3 s without main-thread long tasks > 50 ms.

### 7.2 Performance Guardrails

| Guardrail | Limit | Enforcement |
|---|---|---|
| Initial JS+CSS (gzip) | < 40 KB | CI size check (`size-limit`), build fails above budget |
| Per-tick main-thread time | < 8 ms (120 Hz), target p99 < 6 ms | tick instrumentation; dev overlay; perf test |
| Vertices per active record | 4,096 pairs | split-commit: commit record, start continuation record at last point with same attributes (spine records keep last 2 spine points for continuity) |
| Active vertices total | 65,536 pairs | forced commit of all active records |
| Active records | 64 | forced commit oldest |
| Uncommitted time | 30 s of continuous stroke | forced split-commit (bounds Ribbon/Inverse hover shapes) |
| Committed shapes / vertices | 50,000 / 4,000,000 | baking (2.7) |
| Worker replay per frame | 4 ms | tile queue time slicing |
| Main-thread fallback replay | 2 ms | same |
| JS heap (main + workers) | < 100 MB | `performance.measureUserAgentSpecificMemory()` (when cross-origin isolated) sampled every 30 s, else `performance.memory` (Chromium) heuristic; triggers baking and Path2D LRU shrink at 80 MB |
| Session PDF memory | 64 MB / 200 pages | forced download + flush |
| Canvas backing area | <= 16.7 Mpx per canvas (iOS Safari limit), total canvas memory <= 256 MB | clamp dpr: `dprEff = min(dpr, sqrt(16.7e6 / (cssW cssH)))` |
| Hover message batch | 1 per tick, <= 64 samples | coalesce |
| Audio blocks | consumer reads latest only | ring overwrite |
| Long tasks | none > 50 ms on main thread after boot | PerformanceObserver `longtask` logged in dev |

### 7.3 Bundle and Load Plan (offline after load)

Note: route-level budgets and the Service Worker are now defined in 8.7 and 8.8, which take precedence over this subsection.

| Chunk | Contents | gz budget | Loaded |
|---|---|---|---|
| `app.js` (inline in HTML) | engine core, input, active renderer, core modules (Shapes, Speed, Pressure, Scrawl, Detach, Mirror, Gradient, Displace, ColorSwitcher, Blindness, Limit), HUD (Preact + signals), prefs | 30 KB | initial |
| `app.css` (inline) | HUD styles | 3 KB | initial |
| `render.worker.js` | RenderCore, tile grid, SVG/PNG export, committed affects (Random, Smooth, MicExpand, Repeat) | 9 KB | initial, `new Worker(url, {type:'module'})` started in parallel with first paint |
| `audio.js` + worklet | AudioWorklet source, mic modules (MicShapes, MicExpand glue, PitchShapes) | 4 KB | on first mic module |
| `compute.worker.js` | SVG stamp parser, trace maps, marching squares, Evolve, Type | 8 KB | on demand |
| `pdf.js` | PDF writer | 6 KB | on first session save / PDF export |
| `stamps.json` | bundled PullShapes stamps | 20-40 KB | on PullShapes setup |
| Remaining create modules | Median, Pull, Ribbon, Splatter, Trace, Inverse, X, Type, Evolve | 1-3 KB each | on selection |

Initial payload = app.js + app.css (single HTML document, one request) = ~33 KB gz, render worker counted separately but loaded concurrently (+9 KB = 42 KB; the 40 KB initial budget applies to the critical HTML; the worker is non-blocking and the main-thread fallback covers its absence for the first frames). If strict 40 KB including the worker is required, move Displace, ColorSwitcher and Limit to lazy chunks (-3 KB) and Preact to a hand-rolled 1 KB signal-to-DOM binder (-4 KB).

Offline: after first load, no network access is ever made (no fonts, analytics, CDNs, or remote APIs). All chunks are prefetched with `<link rel="modulepreload">` during idle after first paint (`requestIdleCallback`), so selecting any module later works offline in the same tab. Hashed filenames, `Cache-Control: public, max-age=31536000, immutable`; HTML `no-cache`. Offline reload and install are guaranteed by the Service Worker (8.7), now in MVP scope.

Thread topology summary:
```
Main thread:  input capture -> InputRing -> tick(): modules (ACTIVE), active+guide render, HUD
     | transfer (commit batches, hover, params)           ^ acks, clones, blobs
Render worker: OffscreenCanvas committed layer, CommittedLog, SpatialGrid, tile replay, COMMITTED affects, SVG/PNG export
Compute worker (lazy): trace maps, SVG parse, glyph trace, Evolve, PDF assembly
AudioWorklet (lazy): level metrics -> ring
```
Feature detection matrix (verified November 2026 references):

| Feature | Chromium | Firefox | Safari | Fallback |
|---|---|---|---|---|
| OffscreenCanvas 2D in worker | yes | yes | 16.4+ | main-thread RenderCore |
| WebGL2 in worker (Phase 2) | yes | yes | 17+ (OS-dependent) | 2D |
| `desynchronized` context hint | yes | ignored | ignored | normal vsync |
| `getCoalescedEvents` | yes | yes | yes | single event |
| `getPredictedEvents` | yes | yes | 18.2+ | no prediction |
| `pointerrawupdate` | yes | yes | no | `pointermove` coalesced |
| AudioWorklet | yes | yes | 14.1+ | AnalyserNode polling |
| `queryLocalFonts` | yes (permission) | no | no | generic families |
| Keyboard Lock | yes (fullscreen) | no | no | remapped chords |
| `ClipboardItem` image/png | yes | 127+ | 13.1+ | download |
| `EyeDropper` | yes | no | no | canvas sampling only |

Phase 2 (not MVP): WebGL2 committed renderer behind the same `RenderCore` interface: stencil-then-cover path fills (nonzero via INCR/DECR wrap, evenodd via INVERT), strokes expanded to triangle strips on CPU in the worker, tiles as texture atlas, MSAA 4x renderbuffer. Justification threshold: adopt only if 2D tile replay exceeds 4 ms/frame for typical mutation workloads on target hardware.

### 7.4 Legacy Desktop Behaviors Blocked by the Browser Sandbox

| Legacy behavior | Why blocked | Web replacement |
|---|---|---|
| Switch Vector (Mod+V): temp PDF/SVG, launch Illustrator/Inkscape via `open -a` / exe path | No process spawning, no arbitrary file paths | One-click "Copy as SVG+PNG" (`navigator.clipboard.write`), "Download SVG", Web Share API (`navigator.share({files:[svgFile]})`) on mobile when `canShare` |
| Switch Bitmap (Mod+B): temp PNG, launch Photoshop | same | Copy PNG to clipboard; Download PNG; Share |
| Set Vector/Bitmap App preferences | no app registry | removed |
| PullShapes scanning `./shapes` directories (recursive PDF discovery, MIME sniffing) | No directory access without user gesture; PDFs need a renderer | Bundled stamp manifest (build-time converted), drag-and-drop / file input SVG import; optional `showDirectoryPicker()` (Chromium) to import a folder of SVGs once per session |
| Shapes from PDF files (PullShapes, Evolver "PDF...") | PDF vector extraction needs a full parser (> 100 KB) | SVG import; [DIVERGENCE] |
| Loading a session PDF to draw over (multi-page navigation) | same | Load PNG/JPEG/SVG as background image; multi-page draw-over dropped |
| Session recording appending to a PDF on disk every interval | No silent file writes | Snapshot pages saved into the local document (8.4); "Export pages as PDF"; optional File System Access `showSaveFilePicker` (Chromium) for live PDF append after one user grant |
| Session directory, export directory prefs | no paths | browser download location |
| TraceShapes random Flickr image (hard-coded API key, obsolete endpoints) | network dependency, dead API, key exposure | Local file/drop/paste, webcam |
| Swatch ColourLovers palette fetch | network | bundled palettes |
| Transparent fullscreen (desktop screenshot behind canvas, Mod+T) | Cannot read the desktop | Optional `getDisplayMedia` single-frame capture used as background image (explicit user consent each time); default removed |
| `java.util.prefs` | | localStorage (3.3) |
| System font enumeration (TypeShapes) | fingerprinting protection | `queryLocalFonts()` with permission, else generic families |
| JPF plugin zip discovery in `./modules` | no filesystem, no runtime code loading from disk | static registry, lazy chunks |
| Native print dialog with page setup | | `window.print()` on a print-only `<img>` of the PNG export (CSS `@page { size: landscape }`) |
| Help opening local `Alchemy.pdf` | | in-app help dialog |
| ShapeSwap writing `foo.xml` to CWD | | removed |
| Mic hardware format probing (first mono 16-bit line, 41000 Hz typo) | | Web Audio native rate (44.1/48 kHz) |
| JPen 200 Hz tablet polling, eraser end detection | | PointerEvents; eraser via `buttons & 32` (Wacom on Windows/Chromium); not available for Apple Pencil (no eraser end) |
| Global keyboard shortcuts Ctrl+N/T/W/R/L | browser-reserved | remapped (1.3.1), Keyboard Lock in fullscreen |

### 7.5 Legacy Bug Disposition

| Bug | Module | Disposition |
|---|---|---|
| Upper pitch slider bound to lower slider listener | PitchShapes | fixed |
| Rebuilds audio graph and toolbar section on every reselect | PitchShapes | fixed (setup once) |
| `averageSpeed` list inserts instead of replacing (unbounded growth) | XShapes | fixed (10-slot ring) |
| Comparator returns only 1/0; remove-in-loop skips elements | EvolveShapes | fixed |
| Initial gap 51 vs UI default 11 | EvolveShapes | UI default used |
| Size field 2.0/2.5 vs UI default mapping 2.1 | PullShapes, TypeShapes | UI default used |
| Missing `shapes` dir NPE; combo null on reload | PullShapes | n/a (manifest) |
| Loop bound `pts.length/2` moves only first two points; sample index out of bounds | MicExpand | fixed |
| `firstRun` never reset; microphone thread races with UI thread | MicExpand | fixed (tick-driven) |
| Gradient not re-reflected on clone update | Mirror | fixed |
| Axis set from raw screen coordinates while zoomed | Mirror | fixed by view-space design |
| Writes into `affectShapes` assuming exclusive ownership | Mirror | fixed (owned ranges) |
| Smooth repeat copies lose color/style | Smooth | [DIVERGENCE] attributes copied |
| `random(0.1, 57.2958)` rotation units confusion | PullShapes | kept (uniform angle) |
| Random translation uses canvas width for both axes | TypeShapes | fixed |
| Guides baked into buffer on commit | AlcCanvas | fixed |
| Zoom applies horizontal gradient flip | AlcCanvas | fixed |
| Module 0 setup runs twice | AlcPlugins | fixed |
| ALT/SHIFT module shortcut off-by-one for modules 11+ | AlcShortcuts | fixed |
| Session page wrap to index 0 (PDF pages 1-based) | AlcSession | n/a (feature dropped) |
| Simple toolbar line-weight highlight off by one | AlcSimpleToolBar | fixed |
| Transparency slider initial 254 | AlcToolBar | 255 |
| `MOD+N` / `MOD+S` vs `S` style conflicts by modifier only | AlcShortcuts | kept (modifier-distinguished), documented |

### 7.6 [UNKNOWN] Register

| Item | Decision |
|---|---|
| Legacy event rate for per-event speed modules (hardware-dependent) | Resample to 120 Hz (4.2.2), pref 60-240 |
| `buf[0]` endianness in MicShapes shake | High byte of first sample |
| Beads power units for 1000 energy gate | -50 dBFS gate, adjustable |
| Legacy mic sample rate (41000 typo / hardware native) | Context native rate; level metric is rate-independent |
| `lineTo` gating when line smoothing is off | Gating kept |
| Gradient color includes alpha | Yes |
| Module discovery order beyond explicit sort list | Alphabetical |
| Tanagram stamp folder content | Converted as-is at build |
| `AlcShape.move` absolute vs relative (Pull/Evolve centering) | Relative translate so bbox center lands on pointer |
| Right-click color button picker semantics (slot 1) | Opens eraser-slot picker |
| Unsaved session pages on tab close | Lost unless downloaded; `beforeunload` warning |
| `normailzeShapes` target meaning | Longest side = 100, origin at 0,0 |

---

## 8. Application Shell, Local-First Documents, Undo & PWA

This section supersedes the "single-page drawing tool" assumptions elsewhere in the spec wherever they conflict.

### 8.1 Product Decisions

| Decision | Choice |
|---|---|
| Accounts / backend | None. Local-first: all data lives in the browser (8.6). |
| Server rendering | None. Static SPA. No SEO surface needed inside the app. |
| Document model | File = ordered list of fixed-size pages; each page is one Alchemy canvas. |
| Editor default | Focus mode: full-viewport page + small floating toolbar (8.3.2). |
| Undo / redo | Yes, per page, operation history (8.5). |
| Installable / offline | Yes: PWA with Service Worker, installable, offline reload guaranteed (8.7). |
| UI library | Preact + signals (React API, knowledge transfers directly) (8.2). |

### 8.2 Final Stack

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) | |
| Build | Vite (ES2022 target, module workers) | |
| UI | Preact 10 + `@preact/signals` | Same JSX, hooks, components as React. Signals let high-frequency readouts (mic meter, pitch, page counter) update single DOM text nodes without re-rendering component trees. `preact/compat` alias available if a React-only library is ever needed. Rationale over React: ~4 KB vs ~45 KB on the editor critical path. |
| Routing | `preact-iso` (lazy routes, ~1.5 KB) | |
| Styling | Plain CSS + Vite CSS Modules, design tokens as custom properties | Zero runtime. |
| Components | No component library. Native `<dialog>`, `popover`, `<input type=range>`, roving-tabindex toolbars | Accessibility from native semantics. |
| Icons | Inline SVG sprite, tree-shaken subset (Lucide, MIT) | |
| Storage | IndexedDB via `idb` (~1.2 KB) + OPFS (Origin Private File System) | 8.6 |
| PWA | `vite-plugin-pwa` (Workbox `injectManifest` with a small custom SW) | 8.7 |
| Engine | `packages/engine`: framework-free TS (sections 2 to 5) | Lint rule forbids UI imports in engine. |
| Tests | Vitest (geometry, storage codecs), Playwright (render golden, perf, PWA offline), `size-limit` | |
| Lint / format | ESLint + typescript-eslint, Prettier | |
| Repo | pnpm workspace monorepo | |

Repository layout:
```
apps/athanor/            Vite app: routes, shell, PWA, UI components
  src/routes/home/       file browser
  src/routes/editor/     editor shell, floating toolbar, panels, dialogs
  src/routes/settings/
  src/sw.ts              Service Worker
packages/engine/         canvases, input, modules, workers (render, compute), audio worklet, export
packages/doc/            document model, page log codec, history ops, .athanor (de)serializer, storage adapters
packages/ui/             shared primitives (Button, Slider, Popover, Toolbar, Dialog, Icon)
tools/stamps/            build-time converter for legacy PullShapes PDFs to stamps.json (not shipped)
```

### 8.3 Routes and Information Architecture

| Route | Purpose | Loaded chunks |
|---|---|---|
| `/` | Home: file browser | shell + home |
| `/f/:fileId` | Editor, opens last viewed page | shell + editor + engine |
| `/f/:fileId/p/:pageId` | Editor deep link to a page | same |
| `/settings` | Preferences, shortcuts editor, storage usage, backup/restore, about | shell + settings |
| `/new?template=:id` | Create file then redirect to editor | shell |
| Launch from OS file handler / share target | Imports then redirects | shell + doc |

Hash-free history routing; the Service Worker serves `index.html` for all navigation requests (SPA fallback works offline).

#### 8.3.1 Home

- Header: app name, New file (primary), Import, Settings.
- Grid of file cards: thumbnail (page 1, 256 px WebP), name (inline rename), page count, relative edit time; context menu: Open, Rename, Duplicate, Export `.athanor`, Delete (moves to Trash, purged after 30 days or manually).
- Sort: last edited (default), name, created. Search by name (client-side filter).
- Templates row: Blank, Blind warm-up (Blindness on), Mirror mandala (Mirror H+V), Trace session (TraceShapes), Timed session (recording every 60 s, auto-clear). A template = initial page size + module/affect preset + prefs overrides stored in the file.
- Empty state: drop zone for `.athanor`, SVG, images.
- Storage strip: used / quota (`navigator.storage.estimate()`), persistence status, "Back up all" (one `.zip` containing every `.athanor`), last backup date, reminder when more than 7 days of edits are unbacked.

#### 8.3.2 Editor: Focus Mode and Floating Toolbar

Layout: page canvas fitted to the viewport (letterboxed on a neutral surround), floating toolbar, everything else hidden.

Floating toolbar (pill, 44 px tall, default bottom-center, draggable to any edge, position persisted):

| Item | Behavior |
|---|---|
| Home | back to `/` (autosave already flushed) |
| Create module | icon + short name; click opens module picker grid (with digit hints); click again toggles its settings flyout |
| Affects | icon with active-count badge; opens checklist; each active affect's settings in the flyout |
| Color | fg dot with alpha ring; click opens picker popover; long-press/right-click opens bg/eraser slot |
| Width | compact stepper 1-75 (hidden when style is FILL) |
| Style | stroke/fill toggle |
| Undo / Redo | disabled state reflects history |
| Page | "3 / 12" opens pages panel; arrows on hover |
| Record | session recording toggle; red pulse when recording, shows countdown ring to next snapshot |
| More (...) | Export, Copy, Clear page, Flip H/V, Background image, Fullscreen, Settings, Shortcuts, Command palette |

Toolbar states:

| State | Visual | Enter | Exit |
|---|---|---|---|
| `IDLE` | opacity 1 | default | stroke starts |
| `DRAWING` | opacity 0.15, `pointer-events: none` | pointerdown on canvas | 300 ms after pointerup |
| `NEAR` | opacity 1 during DRAWING if pointer is within 64 px of the pill while not drawing | proximity | leave |
| `COLLAPSED` | 12 px dot at the pill position | `Mod+Period` or 4-finger tap | same, or click dot |
| `FLYOUT` | module settings panel attached to pill (the legacy sub-toolbar sections, 6.2) | click module/affect | Esc, click outside, pointerdown on canvas |
| `HIDDEN` | not rendered | Blindness strict mode pref, or `H` with Shift | same |

Optional panels (all collapsed by default, toggles remembered per user):
- Pages panel (left, `Mod+Backslash`): thumbnails, drag reorder, add, duplicate, delete, rename, page size badge.
- Swatches panel (right): the legacy swatch bar features (6.1).
- Legacy proximity HUD (1.4) remains available as pref `hud.mode = proximity` for users who want the original top-edge reveal; `docked` gives the legacy Simple toolbar rail.

Command palette (`Mod+K`): fuzzy search over every action id (shortcut table 1.3.1, module selection, page ops, export). Lazy chunk.

#### 8.3.3 Settings

Sections: Drawing (line smoothing, synthetic pressure, input rate), Interface (toolbar mode, theme light/dark/system, reduced motion), Shortcuts (editor from 1.3.1), Session (interval, auto-clear, naming), Modules (enable/disable), Storage (usage, persist request, backup/restore, clear trash, reset app), About.

### 8.4 Document and Page Model

```
File   { id: ULID, name, createdAt, updatedAt, pageOrder: PageId[], lastPageId, preset?: TemplatePreset, thumb?: Blob }
Page   { id: ULID, fileId, name, width, height (CSS px, integers), background: 0xRRGGBB, createdAt,
         origin: 'user' | 'session', logVersion, baseVersion, thumb?: Blob }
```

Page size:
- New file: page size = current viewport CSS size rounded to integers (legacy canvas = window), or a preset: 1920x1080, 1080x1080, A4 landscape 1123x794, A4 portrait 794x1123, custom (max 8192 per side, area clamp per 7.2).
- New page in a file: same size as the current page.
- Pages are fixed-size. The editor view fits the page to the viewport (`scale = min(vw/w, vh/h)`, centered). This replaces the resize protocol of 6.4: window resize changes only the view transform; the committed raster is re-rasterized only on effective device scale change (`dpr * viewScale` crossing 1.25x or 0.8x of the current raster scale), using the progressive path of 2.6.
- Mirror default axes = page center; all module coordinates are page coordinates.

Page operations (document-level, undoable via document history 8.5.4): add, duplicate, delete, reorder, rename, resize (resize does not scale content; content outside is kept in the log and clipped).

Session recording (replaces AlcSession PDF writing): on each interval tick, only if the page changed since the last snapshot:
1. Render worker serializes the current page state (snapshot form, 8.6.2) and creates a new page with `origin: 'session'`, named by `session.filePrefix + dateFormat(now)`, inserted immediately after a "session block" marker of the current page (snapshots accumulate in order).
2. If `session.autoClear`: clear the current page as one undoable history group.
3. Record indicator pulses 500 ms (legacy parity).
"Export pages as PDF" (export dialog) writes any selection of pages with the PDF writer of 3.4.3, one PDF page per document page.

Active page residency: the render worker holds exactly one page fully loaded (log, grid, Path2D cache, history). Switching pages: flush pending writes, swap to the target page (decode snapshot, progressive raster with the stored thumbnail upscaled as placeholder), keep the previous page's final raster as an `ImageBitmap` for instant back-navigation. Adjacent page rasters (prev/next) are prerendered at thumbnail-plus resolution during idle.

### 8.5 Undo / Redo

#### 8.5.1 Model

Per page, the render worker keeps a `HistoryLog` of groups; each group holds operations over the CommittedLog. Shapes are never physically deleted while referenced by history; removal is tombstoning (`alive[id] = 0`), so undo/redo of add/remove is O(ids) plus dirty-tile replay (2.6).

| Op | Payload | Undo | Redo |
|---|---|---|---|
| `ADD` | `firstId, count, under` | tombstone ids | revive ids |
| `REMOVE` | `ids: Uint32Array` (Limit, MicExpand removal) | revive | tombstone |
| `MUTATE` | `id, preImage: ref to history arena (cmd + vtx copy, gradient), postImage ref (lazily captured on undo)` | swap in pre-image | swap in post-image |
| `CLEAR` | `aliveSetRef` (packed bitset of alive ids at clear time) | revive set | tombstone set |
| `FLIP` | `axis` | flip again (self-inverse) | flip |
| `BACKGROUND` | `before, after` (color/image ref) | set before | set after |

Every undo/redo produces `dirty = union of affected bboxes` and enqueues tile replay; FLIP and BACKGROUND trigger the full progressive re-raster.

#### 8.5.2 Grouping Rules

| Source | Group boundary |
|---|---|
| Pointer gesture | `pointerdown` opens a group; all commits (create + affect shapes, split-commits, Ribbon spacing commits, Pull/Evolve/Type stamps) and mutations until `pointerup` belong to it (legacy undo group semantics) |
| Hover-driven affects (Random, Smooth, MicExpand, Repeat) | One group per "hover burst": opens on first mutation, closes after 500 ms without mutation, or on pointerdown, or on module deselect |
| MicExpand continuous mutation | Same burst rule; pre-image captured only on first write to a shape within the group (copy-on-first-write), so a 10 s expansion costs one copy |
| Keyboard/toolbar actions (clear, flip, background, TypeShapes generate, Shapes double-click commit) | One group each |
| Session auto-clear | One group |
| Limit removals triggered by a commit | Same group as that commit |

Undo while a stroke is active: ignored. Undo while uncommitted active shapes exist without a stroke (InverseShapes hover shape, TypeShapes generated cluster, Repeat stamps): first undo discards the uncommitted active shapes (not in history), next undo pops history.

New operation after undo clears the redo stack.

#### 8.5.3 Budget and Interaction with Baking

| Limit | Default | Pref |
|---|---|---|
| `history.maxSteps` | 200 groups per page | 20 to 1000 |
| History arena (pre/post images) | 32 MB per page | 8 to 128 MB |

Oldest groups are dropped when either limit is exceeded. The undo horizon is the oldest retained group. Consequences:
- Shapes tombstoned by a dropped group are physically freed at the next compaction.
- Shapes added by a dropped group become eligible for baking (2.7). Baking never touches shapes within the horizon, so baked content is never undoable (by construction).
- History is in-memory only; it is not persisted across reloads or page switches beyond the resident cache [DIVERGENCE from Figma-like apps, chosen for simplicity]. Post-MVP: persist history ops in the page log (they are already written there as deltas, 8.6.2) and rebuild on load.

#### 8.5.4 Document-Level History

Page operations (add, delete, duplicate, reorder, rename, resize) are kept in a separate main-thread history (max 100 steps). Deleted pages are kept in storage with a `deletedAt` marker until the document history drops the step or the file is closed, then purged. `Mod+Z` applies to the page history when the canvas has focus and to the document history when the pages panel has focus.

### 8.6 Local Storage Architecture

#### 8.6.1 Layout

IndexedDB database `athanor` (schema version migrated with `onupgradeneeded`):

| Store | Key | Content |
|---|---|---|
| `files` | `id` | File record (8.4); index on `updatedAt`, `deletedAt` |
| `pages` | `id` | Page record; index on `fileId` |
| `assets` | `id` | `{fileId \| null, kind: 'stamp' \| 'image', name, mime, blob, meta}`; null fileId = shared library |
| `kv` | key | schema version, last backup timestamp, migration flags |

OPFS (`navigator.storage.getDirectory()`), written only from the render worker using `createSyncAccessHandle()` (synchronous, fast, worker-only):
```
/files/{fileId}/{pageId}.log     append-only page log (8.6.2)
/files/{fileId}/{pageId}.snap    latest compacted snapshot
/files/{fileId}/{pageId}.base    baked base raster (WebP blob)
```
Fallback when OPFS sync access is unavailable: the same byte segments stored as Blobs in an IndexedDB store `segments` keyed `[pageId, seq]`.

Preferences stay in `localStorage` (3.3), synced across tabs via the `storage` event.

#### 8.6.2 Page Log Format (binary, little-endian)

```
FileHeader   : magic "ATHL" | u16 version | u16 flags | u32 width | u32 height | u32 background
Segment      : u32 byteLength | u32 crc32 | u8 kind | payload
  kind 1 COMMIT   : CommitBatch payload (3.2.4) + u32 historyGroupId
  kind 2 REMOVE   : u32 count | u32 ids[]
  kind 3 MUTATE   : u32 id | record header | cmd bytes | vtx f32
  kind 4 CLEAR    : u32 count | u32 ids[]  (or bitset)
  kind 5 FLIP     : u8 axis
  kind 6 REVIVE   : u32 count | u32 ids[]  (written by undo of REMOVE/CLEAR)
  kind 7 BG       : u32 color | u32 assetId (0 = none)
  kind 8 BAKE     : u32 count | u32 ids[] (removed into base raster)
Snapshot (.snap): FileHeader + one COMMIT segment containing all alive shapes in log order + id remap table
```

Write path: the render worker appends a segment for every applied op (including undo/redo effects), buffered and flushed at most every 1000 ms and immediately on `visibilitychange` hidden / `pagehide`. Crash safety: on load, segments are read until the first length/CRC mismatch; the torn tail is discarded (at most ~1 s of work lost).
Compaction: when `log bytes > 2 x snap bytes + 1 MB`, the worker writes a new `.snap` from the live state, then truncates the `.log`. Done in idle time slices.
Load: read `.snap`, then replay `.log` segments, then progressive raster.

#### 8.6.3 `.athanor` Export Format

Store-only ZIP (no compression, CRC32; hand-written writer and reader, ~1.5 KB, worker-side) containing:
```
manifest.json    { "format": "athanor", "version": 1, "name", "createdAt", "pages": [{ "id", "name", "width", "height", "background", "origin" }], "preset" }
pages/{id}.snap  snapshot form
pages/{id}.base  optional baked raster
pages/{id}.webp  thumbnail
assets/{id}.{ext} stamps and reference images used by the file
```
Import validates magic, version, sizes and CRCs; unknown future versions are rejected with a message. "Back up all" = ZIP of `.athanor` files. Restore = import each, skipping files whose id already exists unless "overwrite" is chosen.

#### 8.6.4 Durability and Multi-Tab

- `navigator.storage.persist()` requested on first file creation (Chromium grants automatically for installed apps; Safari treats installed home-screen apps as persistent). Status shown in Settings.
- Safari evicts all script-writable storage of non-installed sites after 7 days without user interaction: the home screen shows an install prompt and backup reminder when running in Safari outside an installed app.
- Quota: `navigator.storage.estimate()`; writes that fail with `QuotaExceededError` pause autosave, show a blocking banner offering export and trash purge; drawing continues in memory.
- Multi-tab: opening a file takes a Web Lock `athanor:file:{id}` (exclusive). A second tab opening the same file gets a read-only view with "Edit here" (requests the lock, the first tab flushes and switches to read-only). `BroadcastChannel('athanor')` propagates file list changes, renames and thumbnails to other tabs.

### 8.7 PWA

Web App Manifest:
```
name: "Athanor", short_name: "Athanor", start_url: "/", scope: "/", display: "standalone",
display_override: ["window-controls-overlay", "standalone"], background_color / theme_color from tokens,
icons: 192, 512, maskable 512, monochrome,
file_handlers: [{ action: "/open", accept: { "application/x-athanor": [".athanor"] } }],   (Chromium desktop)
share_target: { action: "/share", method: "POST", enctype: "multipart/form-data",
                params: { files: [{ name: "files", accept: ["image/*", "image/svg+xml", ".athanor"] }] } },  (Android)
launch_handler: { client_mode: "focus-existing" }
```

Service Worker:
| Request | Strategy |
|---|---|
| Navigations | serve precached `index.html` (app shell) offline-first |
| Hashed build assets (JS, CSS, worker, worklet, fonts, icons, `stamps.json`) | precached at install (full app, every lazy chunk, ~150 to 250 KB total), cache-first |
| `/share` POST | read form files, stash in IndexedDB, redirect to `/?import=pending` |
| Anything else | network only (there is nothing else) |

Update flow: a new SW installs in the background and waits. The app shows "Update ready" in Home and in the editor's More menu; it activates (`skipWaiting` + reload) only on user action, and never while a stroke is active or a write is pending. A shell/engine schema mismatch (page log version) triggers a migration step before the editor opens.

Install prompt: capture `beforeinstallprompt` (Chromium), show an install button in Home after the first saved file; on iOS show a one-time "Add to Home Screen" hint.

Offline guarantee: after the first visit with the SW installed, cold start, reload, every route and every module work with no network.

### 8.8 Loading and Bundle Budgets (supersedes 7.3 budgets)

| Entry | Contents | Budget (gzip) |
|---|---|---|
| Shell | Preact, signals, router, tokens CSS, storage client, SW registration | 12 KB |
| Home route | file grid, templates, import | 8 KB |
| Editor route (critical) | engine core, floating toolbar, core modules, history client | 26 KB |
| Render worker | as 7.3 + page log codec + history | 12 KB |
| Lazy in editor | pages panel, command palette, export dialog, settings flyouts, swatch panel, other modules, PDF, compute worker, audio | per chunk 1 to 8 KB |

Targets: Home cold load (shell + home) <= 20 KB JS+CSS gzip. Editor deep-link cold load (shell + editor) <= 40 KB, the original MVP budget, render worker loaded in parallel and not blocking first paint. All lazy chunks are precached by the SW and prefetched on idle, so selecting anything later costs no network and < 16 ms to evaluate.

Startup sequence for `/f/:id`:
1. HTML + shell (inline critical CSS) paint the editor surround and toolbar skeleton (< 1 frame after parse).
2. In parallel: spawn render worker, transfer OffscreenCanvas, open IndexedDB, read page record, show stored thumbnail scaled as placeholder.
3. Worker loads `.snap` + `.log` from OPFS, progressive raster replaces placeholder.
4. Input is accepted as soon as the active layer exists (step 1), before the page finishes loading: strokes queue normally and commit after the page's log is loaded (commit batches wait in the pool).

---

## Appendix A. Module Catalog

| # | Id | Kind | Domain | Inputs | Lazy | Status |
|---|---|---|---|---|---|---|
| 1 | create.shapes | create | ACTIVE | pointer | no | port |
| 2 | create.micShapes | create | ACTIVE | pointer, mic | audio chunk | port |
| 3 | create.speedShapes | create | ACTIVE | pointer (rate) | no | port |
| 4 | create.detachShapes | create | ACTIVE | pointer | no | port |
| 5 | create.evolveShapes | create | ACTIVE + compute | pointer, pressure, committed | yes | port, SVG import replaces PDF |
| 6 | create.inverseShapes | create | ACTIVE | hover | yes | port, touch divergence |
| 7 | create.medianShapes | create | ACTIVE | pointer (rate) | yes | port |
| 8 | create.pitchShapes | create | ACTIVE | pointer, mic pitch | audio chunk | port |
| 9 | create.pressureShapes | create | ACTIVE | pointer, pressure | no | port |
| 10 | create.pullShapes | create | ACTIVE | pointer, stamps | yes | port, SVG stamps |
| 11 | create.ribbonShapes | create | ACTIVE | pointer | yes | port |
| 12 | create.scrawlShapes | create | ACTIVE | pointer (rate) | no | port |
| 13 | create.splatterShapes | create | ACTIVE | pointer (rate) | yes | port |
| 14 | create.traceShapes | create | ACTIVE + compute | pointer, image/webcam | yes | port, no Flickr |
| 15 | create.typeShapes | create | ACTIVE + compute | pointer, keys, fonts | yes | port, raster-traced glyphs |
| 16 | create.xShapes | create | ACTIVE | pointer (rate) | yes | port |
| 17 | affect.displace | affect | ACTIVE | pointer (rate) | no | port |
| 18 | affect.gradient | affect | ACTIVE | none | no | port |
| 19 | affect.mirror | affect | ACTIVE | pointer (axis) | no | port |
| 20 | affect.blindness | affect | ACTIVE | key R, up | no | port |
| 21 | affect.random | affect | COMMITTED | hover | worker | port |
| 22 | affect.colorSwitcher | affect | ACTIVE | down/drag | no | port |
| 23 | affect.limit | affect | COMMITTED | counts | worker | port |
| 24 | affect.micExpand | affect | COMMITTED | hover, mic | worker + audio | port |
| 25 | affect.repeat | affect | HYBRID | hover, key B | worker | port |
| 26 | affect.smooth | affect | COMMITTED | hover | worker | port |
| - | affect.shapeSwap | affect | - | - | - | dropped (F8) |

## Appendix B. Implementation Order (MVP)

1. Input ring, resampler, prefs, PRNG/noise, AlcShape primitives (5.1) with T1-T3, T6-T8 tests.
2. Active renderer + main-thread RenderCore (fallback path first), commit protocol, Shapes/Speed/Pressure/Scrawl/Detach.
3. Render worker transfer path, tile grid, Path2D cache, hit testing; Random, Smooth, Limit, Repeat.
4. Mirror, Displace, Gradient, ColorSwitcher, Blindness; HUD (MainBar, SwatchBar, SubBar, ColorPicker); shortcuts; viewport lock.
5. Exports: PNG, SVG, clipboard; session recording + PDF writer. App shell, storage, pages, undo, PWA (section 8) in parallel from step 2.
6. Audio: worklet, MicShapes, MicExpand, PitchShapes.
7. Compute worker: Trace (image + webcam), Pull (manifest + SVG import), Type, Evolve; remaining creates (Median, Ribbon, Splatter, Inverse, X).
8. Perf suite, size-limit gate, golden images, baking under stress.

## Appendix C. Research References (browser capability claims)

- Low-latency `desynchronized` canvas hint: https://developer.chrome.com/blog/desynchronized
- `getPredictedEvents` support (Safari 18.2+): https://caniuse.com/mdn-api_pointerevent_getpredictedevents ; WebKit implementation: https://bugs.webkit.org/show_bug.cgi?id=264002
- `pointerrawupdate` (no Safari support): https://docs.w3cub.com/dom/element/pointerrawupdate_event
- OffscreenCanvas compat data (Safari 16.4 2D, 17 WebGL2): https://chromium.googlesource.com/external/github.com/mdn/browser-compat-data/+/73d346309ee9d8be7e32fda8ff574d4c79dd4c51/api/OffscreenCanvas.json ; WebGL-in-worker OS dependence: https://bugs.webkit.org/show_bug.cgi?id=263010
