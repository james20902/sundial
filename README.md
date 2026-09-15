# sundial

A telemetry visualiser and recorder for epoch flight computer software — a
Rust/Tauri desktop app with a web frontend.

Sundial is built around one assumption about the data: **each iteration of the
control loop is timestamped, and every datapoint gathered during that iteration
is tagged to that one timestamp.** That makes a flight log a table with a single
shared time column, which is what lets the whole workspace scrub as one — move
the cursor and every widget shows the same instant.

## What it does

- **Tabs of windows.** Each tab holds its own grid of widgets. Drag widgets by
  the title bar, resize from the edges; the layout snaps to a 12-column grid and
  pushes neighbours out of the way. Layouts persist between sessions.
- **Widgets with their own visualization and data source.** Every widget picks
  its own channels and rendering options independently: time series, numeric
  readout, radial gauge, XY plot, channel table, event list, attitude indicator.
- **A global timeline.** One seek bar at the bottom drives everything. It always
  shows the whole flight, with the zoomed view drawn as a window on top, so you
  never lose your place while zoomed into 200 ms.
- **A collapsible analysis chat.** An LLM with tools that read the loaded log
  directly — it queries channels, time ranges and statistics rather than being
  handed a summary.

## Running it

```bash
npm install
npm run app
```

`npm run dev` alone serves the frontend in a plain browser against a built-in
synthetic flight, which is useful for working on the UI. File loading, live
sources, export and chat all need the Rust backend, so use `npm run app` for the
real thing.

Try it on the bundled sample immediately: **Open log…** → `examples/demo-flight.csv`.

| Command | What it does |
|---|---|
| `npm run app` | Run the desktop app (Vite + Tauri, hot reload) |
| `npm run dev` | Frontend only, in a browser, against the demo flight |
| `npm run app:build` | Build a distributable bundle |
| `npm run typecheck` | Type-check the frontend |
| `cargo test --lib` | Backend tests (run from `src-tauri/`) |

## Loading logs

Point Sundial at a CSV, TSV or JSONL file. The loaders are deliberately
forgiving, because real logs are messy:

- Units are read out of header names — `Altitude (m)`, `accel_z [m/s^2]`.
- OpenRocket-style exports work: `#` comment preambles, and a header row that is
  itself commented out.
- The timestamp column is found by name (`time`, `t`, `millis`, `uptime`, …) and
  converted to seconds. With no recognisable clock, the row index is used and
  the load reports that it did so.
- Columns of words (`state`, `phase`) become **timeline events** rather than
  channels, one per transition.
- Apogee is detected from an altitude-like channel and marked automatically.
- Blank cells become genuine gaps, not zeros. Malformed rows are skipped and
  reported rather than failing the load.

JSONL takes one frame per line, flat or nested:

```json
{"t": 12.84, "altitude": 431.2, "accel_z": 1.02, "event": "APOGEE"}
{"t": 12.86, "values": {"altitude": 433.9, "accel_z": 1.01}}
```

**Export view** writes the currently visible time range back out as CSV — the
recorder half, and the way to cut a clip of interest out of a long log.

## Plugging in a simulator

Live data arrives through a `LiveSource`. One is implemented — a UDP listener
taking one JSON object per frame — and it is the intended hook for simulation
feeds:

```bash
# In Sundial: Live source… → start listening on 127.0.0.1:9870
python3 examples/openrocket_bridge.py
```

Anything that can send a datagram can drive it, so bridging OpenRocket, a SITL
rig, or a hardware-in-the-loop harness is a short script rather than a change to
Sundial. To add a different transport (a serial radio, MQTT, a socket the flight
computer already speaks), implement the trait and register it:

```rust
// src-tauri/src/sources/mod.rs
pub fn build_source(cfg: &LiveSourceConfig) -> Result<Box<dyn LiveSource>, String> {
    match cfg.kind.as_str() {
        "udp" => Ok(Box::new(udp::UdpSource::from_options(&cfg.options)?)),
        "my_radio" => Ok(Box::new(my_radio::MyRadio::from_options(&cfg.options)?)),
        // ...
    }
}
```

`sources/udp.rs` is a complete worked example in about 80 lines.

## The analysis chat

The chat panel (**✦ Analyse**, or `C`) hands the model tools that read the store
directly: `list_channels`, `query_series`, `channel_stats`, `sample_at`,
`find_crossings`, `list_events`. It is told where your cursor is and which
channels are on screen, so "what's happening here?" works. Every tool call it
makes is shown inline, so the analysis can be checked against the data it was
actually based on.

Providers are pluggable; Anthropic is the default. Add a key under ⚙ in the
panel, or set `ANTHROPIC_API_KEY`. Keys are read by the Rust backend and never
reach the web view; a saved key lives in the app config directory with
owner-only permissions. Selecting the OpenAI-compatible provider and pointing
`baseUrl` at `http://localhost:11434/v1` runs the analysis against a local model
instead.

## Keyboard

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `←` `→` | Step one frame (`Shift` for 25) |
| `,` `.` | Jump to previous / next event |
| `Home` `End` | Start / end of log |
| `F` | Fit the whole flight |
| `M` | Drop a marker at the cursor |
| `C` | Toggle the analysis panel |

On the seek bar: click or drag to scrub, drag the window to pan, wheel to zoom,
double-click to fit.

## How it is put together

```
src/                  frontend (React + TypeScript, Vite)
  app/                shell: header, tabs, timeline, chat, widget chrome
  grid/               the snap-to-cell widget canvas and its layout solver
  widgets/            one module per visualization, plus the registry
  state/              workspace/playback/dataset stores, cursor sampler
  data/               backend client, and the browser-mode mock
src-tauri/            backend (Rust)
  store.rs            columnar frame store, range queries, statistics
  sources/            log loaders and the live-source trait
  llm/                provider clients and the telemetry tools
examples/             sample flight log, generator, simulator bridge
```

Two decisions shape most of the rest:

**The store is columnar.** One `times` vector shared by every channel, one
parallel `Vec<f64>` per channel, gaps as `NaN`. Every channel is indexed by the
same frame number, so "what was everything doing at time *t*?" is one binary
search rather than one per channel.

**Range queries are min/max decimated.** Asking for a 90-second window at 1500
pixels returns two points per pixel column — that column's minimum and maximum,
emitted in the order they occurred. Stride sampling would be simpler and would
drop exactly the things that matter in flight data: a pyro firing, a dropped
packet, a single-frame g-spike. The response says how much it decimated, and the
chat tools pass that on to the model so it never mistakes a downsampled trace
for raw data.

Two smaller ones worth knowing about: charts have a **single y-axis** by design
(a second scale makes unrelated series look correlated — use the *normalise*
option to compare differently-scaled channels by shape), and a chart caps at
**eight channels**, which is how many validated, colourblind-distinguishable
hues the palette has.
