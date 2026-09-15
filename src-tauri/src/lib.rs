//! Sundial — telemetry visualiser/recorder for epoch flight computer software.

pub mod llm;
pub mod sources;
pub mod store;

use llm::{ChatContext, ChatReply, ProviderConfig, ToolTrace, UiMessage};
use serde::{Deserialize, Serialize};
use sources::file::LoadReport;
use sources::{LiveHandle, LiveSourceConfig};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use store::{ChannelStats, Dataset, DatasetInfo, FlightEvent, RangeQuery};
use tauri::{AppHandle, Emitter, Manager, State};

/// Events pushed to the frontend. Namespaced so they cannot collide with
/// plugin events.
pub const EV_LIVE_FRAMES: &str = "sundial://live-frames";
pub const EV_LIVE_ENDED: &str = "sundial://live-ended";
pub const EV_CHAT_TOOL: &str = "sundial://chat-tool";

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn new_id(prefix: &str) -> String {
    format!("{prefix}{}", NEXT_ID.fetch_add(1, Ordering::Relaxed))
}

#[derive(Default)]
pub struct AppState {
    datasets: Mutex<HashMap<String, Dataset>>,
    /// Insertion order, so the UI's dataset list is stable.
    order: Mutex<Vec<String>>,
    active: Mutex<Option<String>>,
    live: Mutex<Option<LiveHandle>>,
    llm: Mutex<ProviderConfig>,
}

impl AppState {
    /// Resolve an explicit dataset id, falling back to the active one.
    fn resolve(&self, id: Option<String>) -> Option<String> {
        id.or_else(|| self.active.lock().ok()?.clone())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadResult {
    pub info: DatasetInfo,
    pub report: LoadReport,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTick {
    pub dataset_id: String,
    pub frames: usize,
    pub t1: f64,
    /// Channels that appeared since the last tick, so the UI can refresh its
    /// channel list only when the schema actually changes.
    pub new_channels: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveEnded {
    pub dataset_id: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmStatus {
    pub configured: bool,
    pub kind: String,
    pub model: String,
    pub base_url: Option<String>,
    /// Where the key came from: `env`, `file`, `none`, or `not-required`.
    pub key_source: String,
}

// ---------------------------------------------------------------------------
// Dataset commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn load_log(state: State<AppState>, path: String) -> Result<LoadResult, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("no such file: {path}"));
    }
    let id = new_id("ds");
    let (ds, report) = sources::file::load_any(&p, &id)?;
    let info = ds.info();

    state.datasets.lock().unwrap().insert(id.clone(), ds);
    state.order.lock().unwrap().push(id.clone());
    *state.active.lock().unwrap() = Some(id);

    Ok(LoadResult { info, report })
}

#[tauri::command]
fn list_datasets(state: State<AppState>) -> Vec<DatasetInfo> {
    let datasets = state.datasets.lock().unwrap();
    state
        .order
        .lock()
        .unwrap()
        .iter()
        .filter_map(|id| datasets.get(id).map(|d| d.info()))
        .collect()
}

#[tauri::command]
fn dataset_info(state: State<AppState>, id: Option<String>) -> Option<DatasetInfo> {
    let id = state.resolve(id)?;
    state.datasets.lock().unwrap().get(&id).map(|d| d.info())
}

#[tauri::command]
fn set_active_dataset(state: State<AppState>, id: String) -> Result<DatasetInfo, String> {
    let datasets = state.datasets.lock().unwrap();
    let info = datasets.get(&id).map(|d| d.info()).ok_or("no such dataset")?;
    *state.active.lock().unwrap() = Some(id);
    Ok(info)
}

#[tauri::command]
fn close_dataset(state: State<AppState>, id: String) {
    state.datasets.lock().unwrap().remove(&id);
    state.order.lock().unwrap().retain(|x| x != &id);
    let mut active = state.active.lock().unwrap();
    if active.as_deref() == Some(id.as_str()) {
        *active = state.order.lock().unwrap().last().cloned();
    }
}

#[tauri::command]
fn query_range(
    state: State<AppState>,
    id: Option<String>,
    channels: Vec<String>,
    t0: f64,
    t1: f64,
    max_points: usize,
) -> Result<RangeQuery, String> {
    let id = state.resolve(id).ok_or("no dataset loaded")?;
    let datasets = state.datasets.lock().unwrap();
    let ds = datasets.get(&id).ok_or("no such dataset")?;
    Ok(ds.query(&channels, t0, t1, max_points))
}

#[tauri::command]
fn sample_at(
    state: State<AppState>,
    id: Option<String>,
    t: f64,
    channels: Vec<String>,
    hold: Option<f64>,
) -> Result<Vec<Option<f64>>, String> {
    let id = state.resolve(id).ok_or("no dataset loaded")?;
    let datasets = state.datasets.lock().unwrap();
    let ds = datasets.get(&id).ok_or("no such dataset")?;
    Ok(ds.sample_at(t, &channels, hold.unwrap_or(f64::INFINITY)))
}

#[tauri::command]
fn channel_stats(
    state: State<AppState>,
    id: Option<String>,
    channels: Vec<String>,
    t0: f64,
    t1: f64,
) -> Result<Vec<ChannelStats>, String> {
    let id = state.resolve(id).ok_or("no dataset loaded")?;
    let datasets = state.datasets.lock().unwrap();
    let ds = datasets.get(&id).ok_or("no such dataset")?;
    Ok(ds.stats(&channels, t0, t1))
}

#[tauri::command]
fn add_marker(
    state: State<AppState>,
    id: Option<String>,
    t: f64,
    label: String,
) -> Result<Vec<FlightEvent>, String> {
    let id = state.resolve(id).ok_or("no dataset loaded")?;
    let mut datasets = state.datasets.lock().unwrap();
    let ds = datasets.get_mut(&id).ok_or("no such dataset")?;
    ds.events.push(FlightEvent { t, label, kind: "marker".into() });
    ds.events.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    Ok(ds.events.clone())
}

#[tauri::command]
fn remove_marker(
    state: State<AppState>,
    id: Option<String>,
    t: f64,
) -> Result<Vec<FlightEvent>, String> {
    let id = state.resolve(id).ok_or("no dataset loaded")?;
    let mut datasets = state.datasets.lock().unwrap();
    let ds = datasets.get_mut(&id).ok_or("no such dataset")?;
    ds.events.retain(|e| !(e.kind == "marker" && (e.t - t).abs() < 1e-9));
    Ok(ds.events.clone())
}

/// Write a time slice back out as CSV — the recorder half of the app, and the
/// way to cut a clip of interest out of a long log.
#[tauri::command]
fn export_csv(
    state: State<AppState>,
    id: Option<String>,
    path: String,
    t0: f64,
    t1: f64,
    channels: Option<Vec<String>>,
) -> Result<usize, String> {
    let id = state.resolve(id).ok_or("no dataset loaded")?;
    let datasets = state.datasets.lock().unwrap();
    let ds = datasets.get(&id).ok_or("no such dataset")?;

    let names = channels.unwrap_or_else(|| ds.channel_names());
    let cols: Vec<&store::Channel> = names.iter().filter_map(|n| ds.channel(n)).collect();
    if cols.is_empty() {
        return Err("no matching channels to export".into());
    }

    let mut out = String::new();
    out.push_str("time (s)");
    for c in &cols {
        let m = &c.meta;
        match &m.unit {
            Some(u) => out.push_str(&format!(",{} ({u})", m.name)),
            None => out.push_str(&format!(",{}", m.name)),
        }
    }
    out.push('\n');

    let mut rows = 0usize;
    for (i, t) in ds.times.iter().enumerate() {
        if *t < t0 || *t > t1 {
            continue;
        }
        out.push_str(&format!("{t}"));
        for c in &cols {
            match c.values.get(i) {
                Some(v) if v.is_finite() => out.push_str(&format!(",{v}")),
                _ => out.push(','),
            }
        }
        out.push('\n');
        rows += 1;
    }

    std::fs::write(&path, out).map_err(|e| format!("{path}: {e}"))?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Live sources
// ---------------------------------------------------------------------------

#[tauri::command]
fn start_live_source(
    app: AppHandle,
    state: State<AppState>,
    config: LiveSourceConfig,
) -> Result<DatasetInfo, String> {
    if state.live.lock().unwrap().is_some() {
        return Err("a live source is already running — stop it first".into());
    }

    let source = sources::build_source(&config)?;
    let id = new_id("live");
    let mut ds = Dataset::new(&id, format!("{} (live)", source.describe()), source.describe());
    ds.live = true;
    let info = ds.info();

    state.datasets.lock().unwrap().insert(id.clone(), ds);
    state.order.lock().unwrap().push(id.clone());
    *state.active.lock().unwrap() = Some(id.clone());

    let (handle, rx, done_rx) = sources::spawn(source, id.clone());
    *state.live.lock().unwrap() = Some(handle);

    // Ingest pump: drain frames into the store and tell the UI on a fixed
    // cadence rather than per frame, so a fast feed cannot flood the webview.
    let app_for_pump = app.clone();
    let ds_id = id.clone();
    std::thread::Builder::new()
        .name("sundial-ingest".into())
        .spawn(move || {
            let state = app_for_pump.state::<AppState>();
            let mut last_emit = std::time::Instant::now();
            let mut known: Vec<String> = Vec::new();

            loop {
                match rx.recv_timeout(std::time::Duration::from_millis(100)) {
                    Ok(frame) => {
                        let mut datasets = state.datasets.lock().unwrap();
                        if let Some(ds) = datasets.get_mut(&ds_id) {
                            sources::apply_frame(ds, frame);
                        } else {
                            break; // dataset closed underneath us
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }

                if last_emit.elapsed() >= std::time::Duration::from_millis(100) {
                    last_emit = std::time::Instant::now();
                    let datasets = state.datasets.lock().unwrap();
                    if let Some(ds) = datasets.get(&ds_id) {
                        let names = ds.channel_names();
                        let new_channels: Vec<String> =
                            names.iter().filter(|n| !known.contains(n)).cloned().collect();
                        if !new_channels.is_empty() {
                            known = names;
                        }
                        let tick = LiveTick {
                            dataset_id: ds_id.clone(),
                            frames: ds.frames(),
                            t1: ds.t1(),
                            new_channels,
                        };
                        drop(datasets);
                        let _ = app_for_pump.emit(EV_LIVE_FRAMES, tick);
                    } else {
                        break;
                    }
                }
            }

            let error = match done_rx.recv() {
                Ok(Ok(())) => None,
                Ok(Err(e)) => Some(e),
                Err(_) => None,
            };
            {
                let mut datasets = state.datasets.lock().unwrap();
                if let Some(ds) = datasets.get_mut(&ds_id) {
                    ds.live = false;
                }
            }
            *state.live.lock().unwrap() = None;
            let _ = app_for_pump.emit(EV_LIVE_ENDED, LiveEnded { dataset_id: ds_id, error });
        })
        .map_err(|e| format!("cannot start ingest thread: {e}"))?;

    Ok(info)
}

#[tauri::command]
fn stop_live_source(state: State<AppState>) {
    if let Some(h) = state.live.lock().unwrap().as_ref() {
        h.stop();
    }
}

#[tauri::command]
fn live_status(state: State<AppState>) -> Option<String> {
    state.live.lock().unwrap().as_ref().map(|h| h.description.clone())
}

// ---------------------------------------------------------------------------
// LLM chat
// ---------------------------------------------------------------------------

fn key_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("llm-keys.json"))
}

fn read_keys(app: &AppHandle) -> HashMap<String, String> {
    key_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Resolve the credential for `cfg`: environment first (so CI and shell
/// sessions work without any UI step), then the saved file.
fn resolve_key(app: &AppHandle, cfg: &ProviderConfig) -> (String, &'static str) {
    if let Ok(k) = std::env::var(cfg.env_var()) {
        if !k.is_empty() {
            return (k, "env");
        }
    }
    match read_keys(app).get(&cfg.kind) {
        Some(k) if !k.is_empty() => (k.clone(), "file"),
        _ => (String::new(), if cfg.key_optional() { "not-required" } else { "none" }),
    }
}

#[tauri::command]
fn llm_status(app: AppHandle, state: State<AppState>) -> LlmStatus {
    let cfg = state.llm.lock().unwrap().clone();
    let (key, source) = resolve_key(&app, &cfg);
    LlmStatus {
        configured: !key.is_empty() || cfg.key_optional(),
        kind: cfg.kind,
        model: cfg.model,
        base_url: cfg.base_url,
        key_source: source.into(),
    }
}

#[tauri::command]
fn set_llm_config(
    app: AppHandle,
    state: State<AppState>,
    config: ProviderConfig,
) -> Result<LlmStatus, String> {
    *state.llm.lock().unwrap() = config;
    Ok(llm_status(app, state))
}

/// Persist an API key outside the renderer. The file is written 0600 on unix so
/// it is not world-readable.
#[tauri::command]
fn set_llm_key(app: AppHandle, kind: String, key: String) -> Result<(), String> {
    let path = key_path(&app)?;
    let mut keys = read_keys(&app);
    if key.is_empty() {
        keys.remove(&kind);
    } else {
        keys.insert(kind, key);
    }
    let body = serde_json::to_string_pretty(&keys).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("{}: {e}", path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
async fn chat_send(
    app: AppHandle,
    messages: Vec<UiMessage>,
    context: ChatContext,
) -> Result<ChatReply, String> {
    let state = app.state::<AppState>();
    let cfg = state.llm.lock().unwrap().clone();
    let (key, _) = resolve_key(&app, &cfg);

    let active = state.resolve(None);
    let info = active
        .as_ref()
        .and_then(|id| state.datasets.lock().unwrap().get(id).map(|d| d.info()));
    let system = llm::system_prompt(info.as_ref(), &context);

    // Tools run synchronously between awaits, so the store lock is taken and
    // released inside this closure and never held across a suspension point.
    let exec = |name: &str, input: &serde_json::Value| {
        let datasets = state.datasets.lock().unwrap();
        let ds = active.as_ref().and_then(|id| datasets.get(id));
        llm::tools::execute(ds, name, input)
    };

    let emitter = app.clone();
    let on_tool = move |trace: &ToolTrace| {
        let _ = emitter.emit(EV_CHAT_TOOL, trace.clone());
    };

    llm::run_chat(&cfg, &key, &system, &messages, exec, on_tool).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            load_log,
            list_datasets,
            dataset_info,
            set_active_dataset,
            close_dataset,
            query_range,
            sample_at,
            channel_stats,
            add_marker,
            remove_marker,
            export_csv,
            start_live_source,
            stop_live_source,
            live_status,
            llm_status,
            set_llm_config,
            set_llm_key,
            chat_send,
        ])
        .run(tauri::generate_context!())
        .expect("error while running sundial");
}
