# Bitmap Skin Layout Design

## Summary

Redesign the Winamp renderer to use actual BMP pixel data from `.wsz` skin files as the visual layout, overlaying dynamic content (track title, elapsed time, playlist, etc.) on top. When all required BMPs are present, the player renders genuine skin artwork; otherwise it falls back to the current styled-text renderer.

## Context

Waimea currently extracts **palette colors** from Winamp skin BMPs and uses them to style text/unicode elements. The `skin_bitmap.rs` module can render BMP pixels as terminal graphics using upper-half block characters, but it's only used for the MAIN.BMP background. The goal is to make the layout itself driven by the skin's bitmap resources — so each skin looks visually distinct, not just color-swapped.

## Decision: Layered Bitmap Renderer

**Approach:** Each Winamp BMP gets its own fixed-size zone in the terminal layout. The renderer paints bitmap backgrounds first, then overlays dynamic text on top at the correct pixel positions (matching real Winamp 2.x coordinates).

**Why this over alternatives:**
- Most faithful to real Winamp — each skin's visual design is fully honored
- Well-documented Winamp 2.x pixel coordinates available
- Fixed layout is appropriate for a replica UI
- Tiled or full-frame approaches either distort or break the skin's look

## Skin Layout Zones

The Winamp 2.x main window (MAIN.BMP: 275x116) has well-documented regions. The diagram below shows the **terminal layout** (6 rows) with the corresponding **BMP source coordinates** for extracting each zone's artwork.

### Terminal Layout

```
Terminal Row 0:  TitleBar
Terminal Row 1:  LedTime + Spectrum Visualization
Terminal Row 2:  Marquee (songticker)
Terminal Row 3:  SeekBar
Terminal Row 4:  Transport Buttons + Volume + Balance
Terminal Row 5:  Status (shuffle/repeat/EQ/PL/mono-stereo/source)
```

### BMP Source Coordinates (in MAIN.BMP, 275x116 pixels)

These are the pixel rectangles within MAIN.BMP that contain each zone's artwork:

| Zone | Source Rect (x, y, w, h) in MAIN.BMP | Terminal Row |
|------|--------------------------------------|-------------|
| TitleBar | (0, 0, 275, 20) | Row 0 |
| ClutterBar | (9, 6, 16, 16) | Row 1, left side |
| LedTime | (9, 26, 62, 12) | Row 1, after clutterbar |
| Spectrum | (78, 22, 197, 28) | Row 1, right portion |
| Marquee | (9, 53, 257, 12) | Row 2 |
| SeekBar | (16, 72, 244, 6) | Row 3 |
| Transport (CBUTTONS region) | (0, 57, 136, 36) | Row 4, left side |
| Volume region | (136, 57, 68, 36) | Row 4, center-left |
| Balance region | (204, 57, 68, 36) | Row 4, center-right |
| Status | (0, 93, 275, 23) | Row 5 |

Note: In Winamp 2.x, the CBUTTONS/transport area (y:57-93) and the marquee/seekbar area (y:53-78) overlap in the BMP source. For terminal rendering, they occupy separate rows. The main window is rendered as a single MAIN.BMP background, and zone-specific overlays are placed on their respective terminal rows.

### Additional BMP Source Files

| BMP File | Dimensions | Zone | Source Sub-Rect |
|----------|-----------|------|----------------|
| NUMBERS.BMP | 99x13 | LedTime digits | Full image, or individual digit cells (9x13 each, digits 0-9 + ':') |
| CBUTTONS.BMP | 136x36 | Transport buttons | Full image (6 buttons: prev, rewind, play, pause, stop, fwd) |
| POSBAR.BMP | 307x10 | SeekBar | Full image (track + thumb) |
| TEXT.BMP | 155x74 | Marquee font | Full image (character glyphs) |
| PLAYPAUS.BMP | 42x9 | Play/Pause indicator | Full image (2 states side by side: 21x9 each) |
| TITLEBAR.BMP | 344x87 | TitleBar chrome | Full image (active + inactive titlebar strips) |
| MONOSTER.BMP | 58x24 | Mono/Stereo indicator | Full image (2 states stacked vertically) |
| SHUFREP.BMP | 62x38 | Shuffle/Repeat buttons | Full image (4 states: shuf on/off, rep on/off) |
| VOLUME.BMP | 68x433 | Volume slider | Full image (vertical strip with all slider positions) |

## Rendering Architecture

### New Module: `src/ui/skin_layout.rs`

```rust
/// A rectangle in BMP pixel coordinates
struct BmpRect {
    x: u32, y: u32, w: u32, h: u32,
}

/// Semantic zones in the Winamp main window
enum ZoneKind {
    TitleBar, LedTime, Spectrum, Marquee, SeekBar,
    Transport, Volume, Balance, Status,
}

/// One zone: where to crop from the BMP, which terminal row it maps to
struct SkinZone {
    src_rect: BmpRect,
    terminal_row: u16,  // 0-5 within the main window area
    col_start: u16,     // terminal column offset within the row
}

/// Computed layout for a fully-loaded skin
struct SkinLayout {
    zones: HashMap<ZoneKind, SkinZone>,
    /// Additional BMP images loaded from the skin (not from MAIN.BMP)
    numbers: BmpImage,
    cbuttons: BmpImage,
    posbar: BmpImage,
    text_bmp: BmpImage,
    playpaus: BmpImage,
    titlebar_bmp: BmpImage,
    monoster: Option<BmpImage>,
    shufrep: Option<BmpImage>,
    volume_bmp: Option<BmpImage>,
}
```

Key methods:
- `SkinLayout::from_skin(skin: &WinampSkin) -> Option<SkinLayout>` — returns `None` if any required BMP is missing or fails dimension validation
- Dimension validation: MAIN.BMP must be at least 275x116, NUMBERS.BMP at least 99x13, etc. If a BMP is present but has wrong dimensions, treat it as missing (return `None`)
- **Caching:** `SkinLayout` is computed once when a skin is loaded and stored as `Option<SkinLayout>` on the `App` struct, NOT recomputed per frame

### Rendering Flow

1. `render()` checks `app.skin_layout` (cached) — if `None`, call `render_text_mode()`
2. If layout exists, split terminal into 6-row main window + 1-row playlist title + flexible playlist body + 2-row footer
3. Render MAIN.BMP as full background for the 6-row main window area
4. For each zone with a dedicated BMP (transport, seekbar, etc.), render that BMP sub-region on top of the MAIN.BMP background at the zone's terminal position
5. Overlay dynamic text content (see Dynamic Overlays section)
6. Playlist and footer rendered as styled text (same as current)

### Overlay Rendering Mechanism

Overlays work in **two passes, same frame**:

**Pass 1 — Bitmap paint:** `render_scaled_bitmap()` / `render_bitmap_region()` writes upper-half-block characters into every cell of a zone's terminal area. This creates the visual chrome.

**Pass 2 — Text overwrite:** For zones with dynamic content, we selectively overwrite specific cells with styled `Span` text. This replaces bitmap pixels in those cells with readable text. The overlay text uses the skin's own colors (e.g., `led_on` for LED time, `text_fg`/`text_bg` for marquee).

The approach is character-level: each terminal cell is either bitmap chrome or text overlay. Zones like the titlebar have a small text area (skin name) centered in a wide bitmap background. The LED time zone has ~8 characters of text in a larger bitmap area. The marquee zone is mostly text. The transport zone is mostly bitmap with active-state highlights.

### Key Addition to `skin_bitmap.rs`

```rust
/// Render a sub-rectangle of a BMP into the given terminal area.
/// Crops from (src_x, src_y) with size (src_w, src_h), then scales
/// the cropped image to fill `area`.
/// If src_w or src_h is 0, or area is zero-sized, does nothing.
pub fn render_bitmap_region(
    frame: &mut Frame,
    area: Rect,
    bmp: &BmpImage,
    src_x: u32,
    src_y: u32,
    src_w: u32,
    src_h: u32,
)
```

Implementation: creates a temporary `BmpImage` with only the cropped pixels, then delegates to `render_scaled_bitmap()`.

## Dynamic Overlays

Each bitmap zone has specific areas where Winamp renders dynamic content. We overlay styled text using the skin's own colors.

| Zone | Overlay Content | Colors Source | Terminal Position |
|------|----------------|---------------|-------------------|
| TitleBar | Skin name, window controls | titlebar colors from MAIN.BMP palette | Row 0, centered |
| LedTime | Elapsed time digits (e.g. "12:34") | `led_on`/`led_bg` from NUMBERS.BMP | Row 1, cols ~2-9 |
| Spectrum | Animated bar visualization (same algorithm as current) | `vis_colors` from VISCOLOR.TXT | Row 1, cols ~10+ |
| Marquee | Scrolling track title | `text_fg`/`text_bg` from TEXT.BMP | Row 2, full width |
| SeekBar | Progress position (filled/unfilled ratio) | `seek_filled`/`seek_track` from POSBAR.BMP | Row 3, full width |
| Transport | Active button highlight (play/pause/stop) | `play_indicator`/`pause_indicator` from PLAYPAUS.BMP | Row 4, cols ~0-20 |
| Volume | Volume level fill bars | `led_on` for filled, `led_off` for empty | Row 4, cols ~21-30 |
| Balance | Balance indicator | Same as volume | Row 4, cols ~31-40 |
| Status | Shuffle/repeat state, mono/stereo, source label | `indicator_on`/`indicator_off` | Row 5, positioned |

The bitmap provides **chrome and decoration** (borders, gradients, background patterns), while text overlays provide **readable dynamic content**. The spectrum visualization keeps the current animated bar algorithm, overlaid on the bitmap background using skin vis colors.

No change to: playlist body, input bar, hints bar — these remain styled text with skin colors.

## Required BMPs (All-or-Nothing)

Bitmap mode activates only when **all** of these are present and parse successfully:
- `MAIN.BMP` (existing `main_bitmap` field on `WinampSkin` — already populated)
- `NUMBERS.BMP`, `CBUTTONS.BMP`, `POSBAR.BMP`, `TEXT.BMP`, `PLAYPAUS.BMP`, `TITLEBAR.BMP` (new fields)

If any is missing or fails `parse_bmp_8bit()`, the entire renderer falls back to the current styled-text mode.

Optional BMPs that enhance the display when present:
- `MONOSTER.BMP`, `SHUFREP.BMP`, `VOLUME.BMP`

## Changes to `src/skin.rs`

Add BmpImage fields to `WinampSkin` (alongside the existing `main_bitmap: Option<BmpImage>`):

```rust
// Existing (keep as-is):
pub main_bitmap: Option<BmpImage>,

// New fields:
pub numbers_bitmap: Option<BmpImage>,
pub cbuttons_bitmap: Option<BmpImage>,
pub posbar_bitmap: Option<BmpImage>,
pub text_bitmap: Option<BmpImage>,
pub playpaus_bitmap: Option<BmpImage>,
pub titlebar_bitmap: Option<BmpImage>,
pub monoster_bitmap: Option<BmpImage>,
pub shufrep_bitmap: Option<BmpImage>,
pub volume_bitmap: Option<BmpImage>,
```

`from_wsz()` already has the raw BMP data in `files: HashMap` — call `parse_bmp_8bit()` for each additional file and populate the new fields. `default_skin()` sets all new fields to `None`.

## Changes to `src/ui/winamp.rs`

- Current `render()` renamed to `render_text_mode()` — retains its current behavior exactly as-is (including the existing MAIN.BMP background rendering via `render_scaled_bitmap()`)
- New `render()` checks `app.skin_layout` and dispatches to either `render_bitmap_mode()` or `render_text_mode()`
- New `render_bitmap_mode()` implements the layered bitmap rendering path (Pass 1: bitmaps, Pass 2: overlays)
- `SC` struct and color resolution unchanged — still needed for overlay text colors
- `render_playlist_body()` and `render_footer()` reused by both modes
- Mouse hit-testing and `LayoutRects` same concept, adjusted coordinates for bitmap mode
- All keyboard handling in `app.rs` unchanged

## Changes to `src/app.rs`

Add field to `App`:
```rust
pub skin_layout: Option<SkinLayout>,
```

Set to `Some(SkinLayout::from_skin(&skin)?)` when a skin is loaded, `None` otherwise.

## Layout Sizing

Main window uses **6 fixed terminal rows** (same as current). The MAIN.BMP is scaled to fit this 6-row area. Playlist fills remaining space below. Footer stays at 2 rows. Extra terminal space beyond the bitmap width gets `body_bg` fill on the sides.

## File Summary

| File | Change |
|------|--------|
| `src/skin.rs` | Store additional BmpImage fields, parse them in `from_wsz()` |
| `src/ui/skin_bitmap.rs` | Add `render_bitmap_region()` for sub-rectangle cropping and rendering |
| `src/ui/skin_layout.rs` | **New** — SkinLayout struct, zone definitions, Winamp 2.x pixel coordinates |
| `src/ui/winamp.rs` | Add bitmap mode path, rename current render to text fallback |
| `src/ui/mod.rs` | Add `mod skin_layout;` declaration |
| `src/app.rs` | Add `skin_layout: Option<SkinLayout>` field, populate on skin load |
