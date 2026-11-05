# Bitmap Skin Layout Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Winamp renderer's color-only styled text approach with actual BMP pixel rendering from skin files, overlaying dynamic content on top of the bitmaps.

**Architecture:** Load all BMP images from .wsz files into BmpImage structs. A new SkinLayout module defines Winamp 2.x pixel-coordinate zones. The renderer paints bitmaps first (Pass 1), then overlays dynamic text (Pass 2). Falls back to current text renderer when required BMPs are missing.

**Tech Stack:** Rust, ratatui 0.29, existing BMP parsing in skin.rs, upper-half-block rendering in skin_bitmap.rs

**Spec:** `docs/superpowers/specs/2026-04-15-bitmap-skin-layout-design.md`

---

## Chunk 1: Skin Data Layer

### Task 1: Add BmpImage fields to WinampSkin

**Files:**
- Modify: `src/skin.rs`

- [ ] **Step 1: Add new BmpImage fields to WinampSkin struct**

Add these fields after `main_bitmap` (around line 54):

```rust
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

- [ ] **Step 2: Parse new BMPs in `from_wsz()`**

After the `main_bitmap` line (~line 130), add:

```rust
let numbers_bitmap = parse_bmp_8bit(files.get("NUMBERS.BMP"));
let cbuttons_bitmap = parse_bmp_8bit(files.get("CBUTTONS.BMP"));
let posbar_bitmap = parse_bmp_8bit(files.get("POSBAR.BMP"));
let text_bitmap = parse_bmp_8bit(files.get("TEXT.BMP"));
let playpaus_bitmap = parse_bmp_8bit(files.get("PLAYPAUS.BMP"));
let titlebar_bitmap = parse_bmp_8bit(files.get("TITLEBAR.BMP"));
let monoster_bitmap = parse_bmp_8bit(files.get("MONOSTER.BMP"));
let shufrep_bitmap = parse_bmp_8bit(files.get("SHUFREP.BMP"));
let volume_bitmap = parse_bmp_8bit(files.get("VOLUME.BMP"));
```

Add them to the `Self { ... }` return block (after `main_bitmap,`).

- [ ] **Step 3: Set all new fields to None in `default_skin()`**

Add after `main_bitmap: None,` in `default_skin()` (around line 243):

```rust
numbers_bitmap: None,
cbuttons_bitmap: None,
posbar_bitmap: None,
text_bitmap: None,
playpaus_bitmap: None,
titlebar_bitmap: None,
monoster_bitmap: None,
shufrep_bitmap: None,
volume_bitmap: None,
```

- [ ] **Step 4: Build and verify compilation**

Run: `cargo build 2>&1 | head -30`
Expected: Compiles with warnings about unused fields (expected — they'll be used later).

- [ ] **Step 5: Commit**

```bash
git add src/skin.rs
git commit -m "feat(skin): load additional BMP images from WSZ files"
```

---

### Task 2: Add render_bitmap_region to skin_bitmap.rs

**Files:**
- Modify: `src/ui/skin_bitmap.rs`

- [ ] **Step 1: Implement render_bitmap_region**

Add this function after `render_scaled_bitmap` (after line 55):

```rust
/// Render a sub-rectangle of a BMP into the given terminal area.
/// Crops from (src_x, src_y) with size (src_w, src_h), then scales
/// the cropped image to fill `area`.
pub fn render_bitmap_region(
    frame: &mut Frame,
    area: Rect,
    bmp: &BmpImage,
    src_x: u32,
    src_y: u32,
    src_w: u32,
    src_h: u32,
) {
    if area.width == 0 || area.height == 0 || src_w == 0 || src_h == 0 {
        return;
    }

    // Clamp source rect to BMP bounds
    let src_x = src_x.min(bmp.width.saturating_sub(1));
    let src_y = src_y.min(bmp.height.saturating_sub(1));
    let src_w = src_w.min(bmp.width.saturating_sub(src_x));
    let src_h = src_h.min(bmp.height.saturating_sub(src_y));

    if src_w == 0 || src_h == 0 {
        return;
    }

    // Build a cropped BmpImage
    let mut pixels = vec![0u8; (src_w as usize) * (src_h as usize)];
    for dy in 0..src_h as usize {
        let src_row_start = ((src_y as usize) + dy) * (bmp.width as usize) + (src_x as usize);
        let dst_row_start = dy * (src_w as usize);
        let src_row = &bmp.pixels[src_row_start..src_row_start + (src_w as usize)];
        pixels[dst_row_start..dst_row_start + (src_w as usize)].copy_from_slice(src_row);
    }

    let cropped = BmpImage {
        width: src_w,
        height: src_h,
        palette: bmp.palette.clone(),
        pixels,
    };

    render_scaled_bitmap(frame, area, &cropped);
}
```

- [ ] **Step 2: Build and verify compilation**

Run: `cargo build 2>&1 | head -30`
Expected: Compiles. May have unused warning for `render_bitmap_region` (expected).

- [ ] **Step 3: Commit**

```bash
git add src/ui/skin_bitmap.rs
git commit -m "feat(bitmap): add render_bitmap_region for sub-rectangle rendering"
```

---

## Chunk 2: Skin Layout Module

### Task 3: Create skin_layout.rs with zone definitions

**Files:**
- Create: `src/ui/skin_layout.rs`
- Modify: `src/ui/mod.rs`

- [ ] **Step 1: Create src/ui/skin_layout.rs**

```rust
/// Skin layout zones for bitmap-based Winamp rendering.
///
/// Defines the Winamp 2.x pixel-coordinate regions within MAIN.BMP and maps
/// them to terminal rows. Used by the bitmap renderer to paint chrome from
/// actual skin bitmaps and overlay dynamic content on top.

use std::collections::HashMap;

use ratatui::layout::Rect;

use crate::skin::{BmpImage, WinampSkin};

// ─── BMP source rectangles (Winamp 2.x MAIN.BMP: 275×116) ──────────────

/// A rectangle in BMP pixel coordinates.
#[derive(Debug, Clone, Copy)]
pub struct BmpRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// Semantic zones in the Winamp main window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ZoneKind {
    TitleBar,
    ClutterBar,
    LedTime,
    Spectrum,
    Marquee,
    SeekBar,
    Transport,
    Volume,
    Balance,
    Status,
}

/// One zone: where to crop from MAIN.BMP, which terminal row and column offset.
#[derive(Debug, Clone, Copy)]
pub struct SkinZone {
    pub src_rect: BmpRect,
    pub terminal_row: u16,
    pub col_start: u16,
}

/// Minimum BMP dimensions required for bitmap mode.
struct MinDims {
    w: u32,
    h: u32,
}

/// Computed layout for a fully-loaded skin.
pub struct SkinLayout {
    pub zones: HashMap<ZoneKind, SkinZone>,
    /// Additional BMP images (not from MAIN.BMP).
    pub numbers: BmpImage,
    pub cbuttons: BmpImage,
    pub posbar: BmpImage,
    pub text_bmp: BmpImage,
    pub playpaus: BmpImage,
    pub titlebar_bmp: BmpImage,
    pub monoster: Option<BmpImage>,
    pub shufrep: Option<BmpImage>,
    pub volume_bmp: Option<BmpImage>,
}

impl SkinLayout {
    /// Build a layout from a loaded skin. Returns `None` if any required BMP
    /// is missing or has wrong dimensions (all-or-nothing check).
    pub fn from_skin(skin: &WinampSkin) -> Option<Self> {
        // Required BMPs from MAIN.BMP
        let main = skin.main_bitmap.as_ref()?;
        validate_dims(main, 275, 116)?;

        // Required standalone BMPs
        let numbers = skin.numbers_bitmap.as_ref()?;
        validate_dims(numbers, 9, 13)?;

        let cbuttons = skin.cbuttons_bitmap.as_ref()?;
        validate_dims(cbuttons, 22, 18)?;

        let posbar = skin.posbar_bitmap.as_ref()?;
        validate_dims(posbar, 10, 10)?;

        let text_bmp = skin.text_bitmap.as_ref()?;
        validate_dims(text_bmp, 5, 5)?;

        let playpaus = skin.playpaus_bitmap.as_ref()?;
        validate_dims(playpaus, 2, 9)?;

        let titlebar_bmp = skin.titlebar_bitmap.as_ref()?;
        validate_dims(titlebar_bmp, 2, 2)?;

        // Optional BMPs — no dimension check needed, None is fine
        let monoster = skin.monoster_bitmap.clone();
        let shufrep = skin.shufrep_bitmap.clone();
        let volume_bmp = skin.volume_bitmap.clone();

        // Build zone map with Winamp 2.x MAIN.BMP pixel coordinates
        let zones = build_zones();

        Some(Self {
            zones,
            numbers: numbers.clone(),
            cbuttons: cbuttons.clone(),
            posbar: posbar.clone(),
            text_bmp: text_bmp.clone(),
            playpaus: playpaus.clone(),
            titlebar_bmp: titlebar_bmp.clone(),
            monoster,
            shufrep,
            volume_bmp,
        })
    }

    /// Get the zone info for a given kind.
    pub fn zone(&self, kind: ZoneKind) -> Option<SkinZone> {
        self.zones.get(&kind).copied()
    }

    /// Compute the terminal Rect for a zone within the main window area.
    pub fn zone_rect(&self, kind: ZoneKind, main_area: Rect) -> Rect {
        let zone = self.zones.get(&kind);
        match zone {
            Some(z) => {
                let y = main_area.y + z.terminal_row;
                let x = main_area.x + z.col_start;
                Rect {
                    x,
                    y,
                    width: main_area.width.saturating_sub(z.col_start),
                    height: 1,
                }
            }
            None => Rect::default(),
        }
    }
}

fn validate_dims(bmp: &BmpImage, min_w: u32, min_h: u32) -> Option<()> {
    if bmp.width >= min_w && bmp.height >= min_h {
        Some(())
    } else {
        None
    }
}

fn build_zones() -> HashMap<ZoneKind, SkinZone> {
    let mut m = HashMap::new();
    m.insert(ZoneKind::TitleBar, SkinZone {
        src_rect: BmpRect { x: 0, y: 0, w: 275, h: 20 },
        terminal_row: 0,
        col_start: 0,
    });
    m.insert(ZoneKind::ClutterBar, SkinZone {
        src_rect: BmpRect { x: 9, y: 6, w: 16, h: 16 },
        terminal_row: 1,
        col_start: 0,
    });
    m.insert(ZoneKind::LedTime, SkinZone {
        src_rect: BmpRect { x: 9, y: 26, w: 62, h: 12 },
        terminal_row: 1,
        col_start: 3,
    });
    m.insert(ZoneKind::Spectrum, SkinZone {
        src_rect: BmpRect { x: 78, y: 22, w: 197, h: 28 },
        terminal_row: 1,
        col_start: 11,
    });
    m.insert(ZoneKind::Marquee, SkinZone {
        src_rect: BmpRect { x: 9, y: 53, w: 257, h: 12 },
        terminal_row: 2,
        col_start: 0,
    });
    m.insert(ZoneKind::SeekBar, SkinZone {
        src_rect: BmpRect { x: 16, y: 72, w: 244, h: 6 },
        terminal_row: 3,
        col_start: 0,
    });
    m.insert(ZoneKind::Transport, SkinZone {
        src_rect: BmpRect { x: 0, y: 57, w: 136, h: 36 },
        terminal_row: 4,
        col_start: 0,
    });
    m.insert(ZoneKind::Volume, SkinZone {
        src_rect: BmpRect { x: 136, y: 57, w: 68, h: 36 },
        terminal_row: 4,
        col_start: 20,
    });
    m.insert(ZoneKind::Balance, SkinZone {
        src_rect: BmpRect { x: 204, y: 57, w: 68, h: 36 },
        terminal_row: 4,
        col_start: 30,
    });
    m.insert(ZoneKind::Status, SkinZone {
        src_rect: BmpRect { x: 0, y: 93, w: 275, h: 23 },
        terminal_row: 5,
        col_start: 0,
    });
    m
}
```

- [ ] **Step 2: Add module declaration to src/ui/mod.rs**

Add `mod skin_layout;` after the existing `mod skin_bitmap;` line (line 8):

```rust
mod skin_layout;
```

- [ ] **Step 3: Build and verify compilation**

Run: `cargo build 2>&1 | head -30`
Expected: Compiles with warnings about unused imports/fields.

- [ ] **Step 4: Commit**

```bash
git add src/ui/skin_layout.rs src/ui/mod.rs
git commit -m "feat(layout): add SkinLayout module with Winamp 2.x zone definitions"
```

---

## Chunk 3: App Integration

### Task 4: Add skin_layout field to App and populate on skin load

**Files:**
- Modify: `src/app.rs`
- Modify: `src/main.rs`

- [ ] **Step 1: Add skin_layout field to App**

In `src/app.rs`, add the import at top (after existing imports):

```rust
use crate::ui::skin_layout::SkinLayout;
```

Add field to `App` struct (after `pub winamp_skin: Option<WinampSkin>,` around line 129):

```rust
pub skin_layout: Option<SkinLayout>,
```

Initialize in `App::new()` (after `winamp_skin: None,` around line 212):

```rust
skin_layout: None,
```

Also, in `handle_settings_key()` around line 520, where `self.winamp_skin = None;` is set when switching away from Winamp theme, add immediately after it:

```rust
self.skin_layout = None;
```

- [ ] **Step 2: Populate skin_layout when skins are loaded in main.rs**

In `src/main.rs`, add import at top:

```rust
use ui::skin_layout::SkinLayout;
```

**Site 1:** After `app.winamp_skin = load_winamp_skin();` (line 199), add:

```rust
app.skin_layout = app.winamp_skin.as_ref().and_then(SkinLayout::from_skin);
```

**Site 2:** Inside `SettingsAction::ThemeChanged` (line 377), after `app.winamp_skin = load_winamp_skin();`, add:

```rust
app.skin_layout = app.winamp_skin.as_ref().and_then(SkinLayout::from_skin);
```

**Site 3:** After local skin load (line 455), after `app.winamp_skin = Some(skin);`, add:

```rust
app.skin_layout = app.winamp_skin.as_ref().and_then(SkinLayout::from_skin);
```

**Site 4:** After downloaded skin load (line 733), after `app.winamp_skin = Some(skin);`, add:

```rust
app.skin_layout = app.winamp_skin.as_ref().and_then(SkinLayout::from_skin);
```

- [ ] **Step 3: Build and verify compilation**

Run: `cargo build 2>&1 | head -30`
Expected: Compiles. `skin_layout` field is stored but not yet read by the renderer.

- [ ] **Step 4: Commit**

```bash
git add src/app.rs src/main.rs
git commit -m "feat(app): add skin_layout field, populate on skin load"
```

---

## Chunk 4: Bitmap Renderer

### Task 5: Implement bitmap rendering mode in winamp.rs

**Files:**
- Modify: `src/ui/winamp.rs`

This is the largest task. The current `render()` becomes `render_text_mode()`, and a new `render()` dispatches between modes.

> **Steps 1–3 must be done atomically** — do not commit between them, as partial completion would break the Winamp renderer. Do Steps 1, 2, and 3 together, then build and test.

- [ ] **Step 1: Rename current render() to render_text_mode()**

Rename the `pub fn render(frame: &mut Frame, app: &mut App)` function (line 138) to `fn render_text_mode(frame: &mut Frame, app: &mut App)`.

Keep the MAIN.BMP background rendering block at the top (lines 143-147 in the renamed function). This is important: skins that have MAIN.BMP but are missing other required BMPs will still get their bitmap background in text fallback mode. This preserves the existing behavior.

- [ ] **Step 2: Add new dispatch render() function**

Add above `render_text_mode`:

```rust
pub fn render(frame: &mut Frame, app: &mut App) {
    if app.skin_layout.is_some() {
        render_bitmap_mode(frame, app);
    } else {
        render_text_mode(frame, app);
    }
}
```

- [ ] **Step 3: Implement render_bitmap_mode()**

Add the new function after the dispatch `render()`:

```rust
fn render_bitmap_mode(frame: &mut Frame, app: &mut App) {
    let sc = SC::from_app(app);
    let layout = app.skin_layout.as_ref().expect("skin_layout must be Some");
    let area = frame.area();
    let skin = app.winamp_skin.as_ref().expect("winamp_skin must be Some when layout is Some");
    let main_bmp = skin.main_bitmap.as_ref().expect("main_bitmap required for bitmap mode");

    // Layout: 6-row main window, 1-row playlist title, flexible playlist body, 2-row footer
    let main_rows: u16 = 6;
    let footer_rows: u16 = 2;

    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(main_rows),
            Constraint::Length(1),
            Constraint::Min(3),
            Constraint::Length(footer_rows),
        ])
        .split(area);

    let main_area = vertical[0];
    let pl_title_area = vertical[1];
    let pl_body_area = vertical[2];
    let footer_area = vertical[3];

    // Pass 1: Paint MAIN.BMP as full background for the main window
    skin_bitmap::render_scaled_bitmap(frame, main_area, main_bmp);

    // Pass 2: Overlay dynamic content on each row
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
        ])
        .split(main_area);

    render_bitmap_titlebar(frame, rows[0], app, &sc);
    render_bitmap_time_vis(frame, rows[1], app, &sc);
    render_bitmap_marquee(frame, rows[2], app, &sc);
    render_bitmap_seekbar(frame, rows[3], app, &sc);
    render_bitmap_transport(frame, rows[4], app, &sc);
    render_bitmap_status(frame, rows[5], app, &sc);

    // Playlist and footer — styled text (same as text mode)
    render_playlist_titlebar(frame, pl_title_area, app, &sc);
    render_playlist_body(frame, pl_body_area, app, &sc);
    render_footer(frame, footer_area, app, &sc);

    // Store layout rects for mouse hit-testing
    let seek_rect = Rect::new(main_area.x, main_area.y + 3, main_area.width, 1);
    let transport_rect = Rect::new(main_area.x, main_area.y + 4, main_area.width, 1);
    let pause_button = Rect::new(transport_rect.x + 10, transport_rect.y, 4, 1);

    app.layout_rects = LayoutRects {
        results: pl_body_area,
        player_info: Rect::new(main_area.x, main_area.y, main_area.width, 1),
        player_bar: seek_rect,
        input: Rect::new(footer_area.x, footer_area.y, footer_area.width, 1),
        help: Rect::new(footer_area.x, footer_area.y + 1, footer_area.width, 1),
        pause_button,
        prev_page: Rect::new(
            pl_body_area.x + pl_body_area.width.saturating_sub(6),
            pl_body_area.y, 3, 1,
        ),
        next_page: Rect::new(
            pl_body_area.x + pl_body_area.width.saturating_sub(3),
            pl_body_area.y, 3, 1,
        ),
    };
}
```

- [ ] **Step 4: Implement bitmap overlay functions**

Add these after `render_bitmap_mode`. These overlay dynamic text on top of the MAIN.BMP background that was painted in Pass 1. Each function renders one terminal row.

```rust
// Row 0 — Title bar overlay
fn render_bitmap_titlebar(frame: &mut Frame, area: Rect, app: &App, sc: &SC) {
    let skin_name = app
        .winamp_skin
        .as_ref()
        .map(|s| s.name.as_str())
        .unwrap_or("WINAMP");

    let w = area.width as usize;
    let title = format!(" {skin_name} ");
    let controls = " \u{2500}\u{25A1}\u{2715} ";
    let pad = w.saturating_sub(title.len() + controls.len());

    let line = Line::from(vec![
        Span::styled(
            title,
            Style::default()
                .fg(Color::White)
                .bg(sc.titlebar_bg)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            "\u{2500}".repeat(pad),
            Style::default().fg(sc.titlebar_bg).bg(sc.chrome_dark),
        ),
        Span::styled(
            controls.to_string(),
            Style::default().fg(sc.chrome_light).bg(sc.chrome_dark),
        ),
    ]);
    frame.render_widget(
        Paragraph::new(line).style(Style::default().bg(sc.chrome_dark)),
        area,
    );
}

// Row 1 — LED time + visualization overlay
fn render_bitmap_time_vis(frame: &mut Frame, area: Rect, app: &App, sc: &SC) {
    let elapsed = match &app.playback {
        Some(pb) => pb.elapsed_secs,
        None => 0,
    };

    let is_playing = app.playback.is_some();
    let is_paused = app.playback.as_ref().is_some_and(|p| p.paused);

    let state_icon = if !is_playing {
        Span::styled(" \u{25A0} ", Style::default().fg(sc.indicator_off).bg(sc.led_bg))
    } else if is_paused {
        Span::styled(" \u{2016} ", Style::default().fg(sc.pause_indicator).bg(sc.led_bg))
    } else {
        Span::styled(" \u{25B6} ", Style::default().fg(sc.play_indicator).bg(sc.led_bg))
    };

    let time_str = format!(" {}:{:02} ", elapsed / 60, elapsed % 60);
    let led_time = Span::styled(
        time_str,
        Style::default()
            .fg(sc.led_on)
            .bg(sc.led_bg)
            .add_modifier(Modifier::BOLD),
    );

    // Visualization bars
    let vis_width = (area.width as usize).saturating_sub(14);
    let bar_count = vis_width / 2;
    let seed = elapsed;

    let mut vis_spans: Vec<Span> = Vec::with_capacity(bar_count + 1);
    vis_spans.push(Span::styled(" ", Style::default().bg(sc.body_bg)));

    if is_playing && !is_paused {
        let bar_chars = [
            '\u{2581}', '\u{2582}', '\u{2583}', '\u{2584}',
            '\u{2585}', '\u{2586}', '\u{2587}', '\u{2588}',
        ];
        for i in 0..bar_count {
            let h = ((seed.wrapping_mul(7).wrapping_add(i as u64 * 13)) % 6) as usize + 1;
            let color = if sc.vis_colors.len() > 2 {
                let idx = (h * (sc.vis_colors.len() - 2) / 7).min(sc.vis_colors.len() - 1);
                sc.vis_colors.get(idx + 2).copied().unwrap_or(sc.led_off)
            } else {
                sc.led_off
            };
            let ch = bar_chars[h.min(bar_chars.len() - 1)];
            vis_spans.push(Span::styled(
                format!("{ch} "),
                Style::default().fg(color).bg(sc.led_bg),
            ));
        }
    } else {
        for _ in 0..bar_count {
            vis_spans.push(Span::styled(
                "\u{2581} ",
                Style::default().fg(sc.led_off).bg(sc.led_bg),
            ));
        }
    }

    let mut spans = vec![state_icon, led_time];
    spans.extend(vis_spans);

    frame.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::default().bg(sc.body_bg)),
        area,
    );
}

// Row 2 — Marquee overlay
fn render_bitmap_marquee(frame: &mut Frame, area: Rect, app: &App, sc: &SC) {
    let title = match &app.playback {
        Some(pb) => pb.title.clone(),
        None => match &app.status {
            Status::Loading(t) | Status::Searching(t) | Status::Scanning(t) => t.clone(),
            Status::Error(t) => t.clone(),
            _ => "  ***  waimea  ***  ".into(),
        },
    };

    let w = area.width as usize;
    let display = if title.len() > w.saturating_sub(2) {
        let mut t: String = title.chars().take(w.saturating_sub(3)).collect();
        t.push('\u{2026}');
        t
    } else {
        title
    };

    let line = Line::from(vec![
        Span::styled(" ", Style::default().bg(sc.text_bg)),
        Span::styled(display, Style::default().fg(sc.text_fg).bg(sc.text_bg)),
        Span::styled(
            " ".repeat(w.saturating_sub(1)),
            Style::default().bg(sc.text_bg),
        ),
    ]);
    frame.render_widget(Paragraph::new(line), area);
}

// Row 3 — Seek bar overlay
fn render_bitmap_seekbar(frame: &mut Frame, area: Rect, app: &App, sc: &SC) {
    let (elapsed, duration) = match &app.playback {
        Some(pb) => (pb.elapsed_secs, pb.duration_secs),
        None => (0, 0),
    };

    let ratio = if duration > 0 {
        elapsed as f64 / duration as f64
    } else {
        0.0
    };

    let elapsed_str = format_time(elapsed);
    let duration_str = format_time(duration);
    let label = format!("{elapsed_str} / {duration_str}");

    let gauge = LineGauge::default()
        .ratio(ratio)
        .label(Span::styled(label, Style::default().fg(sc.led_on)))
        .filled_style(Style::default().fg(sc.seek_filled).bg(sc.seek_track))
        .unfilled_style(Style::default().fg(sc.seek_track).bg(sc.body_bg))
        .line_set(ratatui::symbols::line::THICK);

    frame.render_widget(gauge, area);
}

// Row 4 — Transport + Volume + Balance overlay
fn render_bitmap_transport(frame: &mut Frame, area: Rect, app: &App, sc: &SC) {
    let is_paused = app.playback.as_ref().is_some_and(|p| p.paused);
    let is_playing = app.playback.is_some();

    let btn_style = Style::default().fg(sc.btn_text).bg(sc.btn_normal);
    let btn_active = Style::default().fg(Color::Black).bg(sc.chrome_light);
    let sep = Span::styled(" ", Style::default().bg(sc.body_bg));

    let play_style = if is_playing && !is_paused {
        Style::default().fg(Color::Black).bg(sc.play_indicator)
    } else {
        btn_style
    };
    let pause_style = if is_paused {
        Style::default().fg(Color::Black).bg(sc.pause_indicator)
    } else {
        btn_style
    };

    let vol_filled = 7;
    let vol_empty = 3;
    let vol_bar = format!(
        "{}{}",
        "\u{2588}".repeat(vol_filled),
        "\u{2591}".repeat(vol_empty),
    );

    let bal_filled = 5;
    let bal_empty = 5;
    let bal_bar = format!(
        "{}{}",
        "\u{2588}".repeat(bal_filled),
        "\u{2591}".repeat(bal_empty),
    );

    let line = Line::from(vec![
        Span::styled(" \u{23EE} ", btn_active),
        sep.clone(),
        Span::styled(" \u{23EA} ", btn_style),
        sep.clone(),
        Span::styled(" \u{25B6} ", play_style),
        sep.clone(),
        Span::styled(" \u{23F8} ", pause_style),
        sep.clone(),
        Span::styled(" \u{23F9} ", btn_style),
        sep.clone(),
        Span::styled(" \u{23E9} ", btn_style),
        sep.clone(),
        Span::styled(" \u{23ED} ", btn_active),
        Span::styled("  ", Style::default().bg(sc.body_bg)),
        Span::styled("VOL", Style::default().fg(sc.chrome_light).bg(sc.body_bg)),
        Span::styled(vol_bar, Style::default().fg(sc.led_on).bg(sc.body_bg)),
        Span::styled(" ", Style::default().bg(sc.body_bg)),
        Span::styled("BAL", Style::default().fg(sc.chrome_light).bg(sc.body_bg)),
        Span::styled(bal_bar, Style::default().fg(sc.led_on).bg(sc.body_bg)),
    ]);
    frame.render_widget(
        Paragraph::new(line).style(Style::default().bg(sc.body_bg)),
        area,
    );
}

// Row 5 — Status row overlay
fn render_bitmap_status(frame: &mut Frame, area: Rect, app: &App, sc: &SC) {
    let is_playing = app.playback.is_some();

    let shuf_style = Style::default().fg(sc.indicator_off).bg(sc.chrome_dark);
    let rep_style = Style::default().fg(sc.indicator_off).bg(sc.chrome_dark);
    let eq_style = Style::default().fg(sc.indicator_off).bg(sc.chrome_dark);
    let pl_style = Style::default().fg(sc.indicator_on).bg(sc.chrome_dark);

    let (mono_fg, stereo_fg) = if is_playing {
        (sc.indicator_off, sc.indicator_on)
    } else {
        (sc.indicator_off, sc.indicator_off)
    };

    let source_label = match app.active_source {
        crate::media::SourceKind::Local => "LOCAL",
        crate::media::SourceKind::Extractor(_) => "ONLINE",
    };

    let line = Line::from(vec![
        Span::styled(" SHUF ", shuf_style),
        Span::styled(" ", Style::default().bg(sc.body_bg)),
        Span::styled(" REP ", rep_style),
        Span::styled("  ", Style::default().bg(sc.body_bg)),
        Span::styled(" EQ ", eq_style),
        Span::styled(" ", Style::default().bg(sc.body_bg)),
        Span::styled(" PL ", pl_style),
        Span::styled("   ", Style::default().bg(sc.body_bg)),
        Span::styled("mono", Style::default().fg(mono_fg).bg(sc.body_bg)),
        Span::styled("/", Style::default().fg(sc.chrome_mid).bg(sc.body_bg)),
        Span::styled("stereo", Style::default().fg(stereo_fg).bg(sc.body_bg)),
        Span::styled("   ", Style::default().bg(sc.body_bg)),
        Span::styled(
            format!(" {source_label} "),
            Style::default()
                .fg(sc.titlebar_bg)
                .bg(sc.chrome_dark)
                .add_modifier(Modifier::BOLD),
        ),
    ]);
    frame.render_widget(
        Paragraph::new(line).style(Style::default().bg(sc.body_bg)),
        area,
    );
}
```

- [ ] **Step 5: Remove the unused skin_bitmap import from render_text_mode**

Since we removed the MAIN.BMP background rendering from `render_text_mode`, the `use crate::ui::skin_bitmap;` import at line 31 is now only needed by `render_bitmap_mode`. Keep the import — it's still used by the bitmap mode.

- [ ] **Step 6: Build and verify compilation**

Run: `cargo build 2>&1 | head -40`
Expected: Compiles successfully.

- [ ] **Step 7: Run the application to test**

Run: `cargo run`
Expected: If a skin with all required BMPs is loaded, the main window shows the MAIN.BMP bitmap background with styled text overlays. Playlist and footer look the same as before. If BMPs are missing, the current text-mode renderer is used.

- [ ] **Step 8: Commit**

```bash
git add src/ui/winamp.rs
git commit -m "feat(renderer): add bitmap mode with MAIN.BMP background and text overlays"
```

---

## Summary of Changes

| Task | File(s) | Description |
|------|---------|-------------|
| 1 | `src/skin.rs` | Load 9 additional BMP images from WSZ files |
| 2 | `src/ui/skin_bitmap.rs` | Add `render_bitmap_region()` for sub-rect rendering |
| 3 | `src/ui/skin_layout.rs`, `src/ui/mod.rs` | New SkinLayout module with Winamp zone definitions |
| 4 | `src/app.rs`, `src/main.rs` | Cache SkinLayout on App, populate at all skin load sites |
| 5 | `src/ui/winamp.rs` | Bitmap rendering mode with MAIN.BMP background + text overlays |
