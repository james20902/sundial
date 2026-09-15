//! Pluggable LLM chat with real access to the loaded flight log.
//!
//! The chat panel exists so a model can analyse the raw telemetry, which means
//! it needs to *query* the data rather than be handed a summary. Every provider
//! here therefore runs a tool loop against [`tools`], and the model decides
//! which channels and time ranges it actually wants to look at.
//!
//! Providers are a closed enum rather than a trait object: there are only a
//! handful of wire formats worth supporting, an enum keeps the loop free of
//! async-trait machinery, and adding one is a module plus a match arm.
//!
//! API keys never reach the renderer — the key is read from the environment or
//! from a file in the app config directory, and only a "configured / not
//! configured" flag is reported to the UI.

pub mod anthropic;
pub mod openai;
pub mod tools;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

/// How many request/tool-execute round trips one user message may take before
/// the loop gives up. Bounded so a confused model cannot bill indefinitely.
const MAX_ITERATIONS: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    /// `anthropic` or `openai`.
    pub kind: String,
    pub model: String,
    /// Override for OpenAI-compatible servers (Ollama, LM Studio, vLLM).
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
}

fn default_max_tokens() -> u32 {
    16000
}

impl Default for ProviderConfig {
    fn default() -> Self {
        ProviderConfig {
            kind: "anthropic".into(),
            model: anthropic::DEFAULT_MODEL.into(),
            base_url: None,
            max_tokens: default_max_tokens(),
        }
    }
}

impl ProviderConfig {
    /// Environment variable consulted before the on-disk key.
    pub fn env_var(&self) -> &'static str {
        match self.kind.as_str() {
            "openai" => "OPENAI_API_KEY",
            _ => "ANTHROPIC_API_KEY",
        }
    }

    /// A local model server needs no credential, so an empty key is allowed
    /// when the endpoint has been pointed at localhost.
    pub fn key_optional(&self) -> bool {
        self.kind == "openai"
            && self
                .base_url
                .as_deref()
                .map(|u| u.contains("localhost") || u.contains("127.0.0.1"))
                .unwrap_or(false)
    }
}

/// A message as the chat panel stores it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
}

pub struct Turn {
    pub text: String,
    pub calls: Vec<ToolCall>,
    /// Provider-native assistant message, echoed back verbatim on the next
    /// request so reasoning blocks survive the round trip.
    pub assistant: Value,
    #[allow(dead_code)]
    pub stop_reason: Option<String>,
    pub usage: Option<Usage>,
}

/// What the model looked at, surfaced in the transcript so the operator can
/// check the analysis against the data it was actually based on.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolTrace {
    pub name: String,
    pub input: Value,
    pub summary: String,
    pub is_error: bool,
}

/// Where the operator is looking, so the model can answer "what's happening
/// here?" without being told the numbers.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatContext {
    pub cursor: f64,
    pub view_t0: f64,
    pub view_t1: f64,
    #[serde(default)]
    pub focus_channels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub text: String,
    pub tool_calls: Vec<ToolTrace>,
    pub usage: Option<Usage>,
}

pub fn system_prompt(dataset: Option<&crate::store::DatasetInfo>, ctx: &ChatContext) -> String {
    let mut s = String::from(
        "You are the analysis assistant inside Sundial, a telemetry visualiser for model \
         rocket and UAV flight computers. The operator is scrubbing through a flight log.\n\n\
         You have tools that read the actual samples. Use them — never guess at values, and \
         never invent a channel name you have not seen in list_channels. Start by listing \
         channels if you do not already know what the log contains.\n\n\
         When you report a number, say which channel and time it came from. Telemetry is \
         noisy: distinguish a real signal from a single-frame spike, and say so when a \
         reading looks like a sensor artefact rather than physics. Keep answers short and \
         concrete — the operator is reading them in a side panel, not a report.\n",
    );

    match dataset {
        Some(d) => {
            s.push_str(&format!(
                "\nLoaded log: '{}' ({}), {} frames spanning t = {:.3} .. {:.3} s, \
                 {} channels.\n",
                d.name,
                d.source,
                d.frames,
                d.t0,
                d.t1,
                d.channels.len()
            ));
            if !d.events.is_empty() {
                let ev: Vec<String> = d
                    .events
                    .iter()
                    .take(12)
                    .map(|e| format!("{:.2}s {}", e.t, e.label))
                    .collect();
                s.push_str(&format!("Timeline events: {}\n", ev.join("; ")));
            }
            s.push_str(&format!(
                "The playback cursor is at t = {:.3} s and the visible window is \
                 {:.3} .. {:.3} s.\n",
                ctx.cursor, ctx.view_t0, ctx.view_t1
            ));
            if !ctx.focus_channels.is_empty() {
                s.push_str(&format!(
                    "Channels currently on screen: {}. Prefer these when the operator says \
                     'this' or 'that' without naming a channel.\n",
                    ctx.focus_channels.join(", ")
                ));
            }
        }
        None => s.push_str("\nNo flight log is loaded yet. Say so if asked about data.\n"),
    }
    s
}

/// Run one chat turn to completion, executing tools as the model requests them.
///
/// `exec` runs a tool synchronously — it is called between awaits, so it may
/// take the store lock without risk of holding it across a suspension point.
/// `on_tool` is invoked as each call completes so the UI can show progress.
pub async fn run_chat(
    cfg: &ProviderConfig,
    api_key: &str,
    system: &str,
    history: &[UiMessage],
    mut exec: impl FnMut(&str, &Value) -> tools::ToolOutcome,
    mut on_tool: impl FnMut(&ToolTrace),
) -> Result<ChatReply, String> {
    let is_anthropic = cfg.kind != "openai";
    if api_key.is_empty() && !cfg.key_optional() {
        return Err(format!(
            "No API key configured. Set {} or save a key in chat settings.",
            cfg.env_var()
        ));
    }

    let specs = tools::specs();
    let mut messages: Vec<Value> = history
        .iter()
        .map(|m| {
            if m.role == "assistant" {
                if is_anthropic {
                    anthropic::assistant_text_message(&m.content)
                } else {
                    openai::assistant_text_message(&m.content)
                }
            } else if is_anthropic {
                anthropic::user_message(&m.content)
            } else {
                openai::user_message(&m.content)
            }
        })
        .collect();

    let client = reqwest::Client::builder()
        // Generous: a tool loop over a long log with a reasoning model can
        // legitimately take a while, and a premature timeout loses the work.
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let url = if is_anthropic { anthropic::endpoint(cfg) } else { openai::endpoint(cfg) };
    let hdrs = if is_anthropic { anthropic::headers(api_key) } else { openai::headers(api_key) };

    let mut traces: Vec<ToolTrace> = Vec::new();
    let mut total = Usage { input_tokens: 0, output_tokens: 0 };

    for _ in 0..MAX_ITERATIONS {
        let body = if is_anthropic {
            anthropic::build_body(cfg, system, &messages, &specs)
        } else {
            openai::build_body(cfg, system, &messages, &specs)
        };

        let mut req = client.post(&url);
        for (k, v) in &hdrs {
            req = req.header(*k, v);
        }
        let resp = req
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    "request timed out after 300s".to_string()
                } else if e.is_connect() {
                    format!("cannot reach {url}: {e}")
                } else {
                    format!("request failed: {e}")
                }
            })?;

        let status = resp.status();
        let payload: Value = resp
            .json()
            .await
            .map_err(|e| format!("HTTP {status}: response was not JSON ({e})"))?;

        if !status.is_success() {
            let detail = payload
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("no detail");
            return Err(match status.as_u16() {
                401 | 403 => format!("HTTP {status}: authentication failed — check the API key."),
                429 => format!("HTTP {status}: rate limited — retry shortly. {detail}"),
                s if s >= 500 => format!("HTTP {status}: provider error — {detail}"),
                _ => format!("HTTP {status}: {detail}"),
            });
        }

        let turn = if is_anthropic {
            anthropic::parse_turn(&payload)?
        } else {
            openai::parse_turn(&payload)?
        };

        if let Some(u) = &turn.usage {
            total.input_tokens += u.input_tokens;
            total.output_tokens += u.output_tokens;
        }

        if turn.calls.is_empty() {
            return Ok(ChatReply {
                text: turn.text,
                tool_calls: traces,
                usage: Some(total),
            });
        }

        messages.push(turn.assistant.clone());

        let mut results: Vec<(String, String, bool)> = Vec::new();
        for call in &turn.calls {
            let outcome = exec(&call.name, &call.input);
            let trace = ToolTrace {
                name: call.name.clone(),
                input: call.input.clone(),
                summary: outcome.summary.clone(),
                is_error: outcome.is_error,
            };
            on_tool(&trace);
            traces.push(trace);
            results.push((call.id.clone(), outcome.content, outcome.is_error));
        }

        if is_anthropic {
            messages.push(anthropic::tool_result_message(&results));
        } else {
            messages.extend(openai::tool_result_messages(&results));
        }
    }

    Err(format!(
        "Gave up after {MAX_ITERATIONS} tool rounds without a final answer. Try a narrower question."
    ))
}
