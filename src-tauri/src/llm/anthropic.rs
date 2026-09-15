//! Anthropic Messages API wire format.
//!
//! Rust has no official Anthropic SDK, so this speaks the REST API directly.
//! Two details matter for correctness:
//!
//! * Adaptive thinking is on by default for current models, and the `thinking`
//!   blocks that come back must be echoed to the next request **unchanged**.
//!   Appending the response's whole `content` array as the assistant turn does
//!   that without the caller having to know about thinking at all.
//! * A safety decline arrives as HTTP 200 with `stop_reason: "refusal"`, not as
//!   an error status, so it has to be checked explicitly.

use super::{ProviderConfig, ToolCall, Turn, Usage};
use serde_json::{json, Value};

pub const DEFAULT_MODEL: &str = "claude-opus-5";
pub const DEFAULT_BASE: &str = "https://api.anthropic.com";
const API_VERSION: &str = "2023-06-01";

pub fn endpoint(cfg: &ProviderConfig) -> String {
    let base = cfg.base_url.as_deref().unwrap_or(DEFAULT_BASE).trim_end_matches('/');
    format!("{base}/v1/messages")
}

pub fn headers(api_key: &str) -> Vec<(&'static str, String)> {
    vec![
        ("x-api-key", api_key.to_string()),
        ("anthropic-version", API_VERSION.to_string()),
        ("content-type", "application/json".to_string()),
    ]
}

pub fn build_body(
    cfg: &ProviderConfig,
    system: &str,
    messages: &[Value],
    tools: &[Value],
) -> Value {
    json!({
        "model": cfg.model,
        "max_tokens": cfg.max_tokens,
        "system": system,
        // Adaptive thinking; `budget_tokens` is rejected on current models.
        "thinking": { "type": "adaptive" },
        "tools": tools,
        "messages": messages,
    })
}

/// Wrap a plain user string in the native message shape.
pub fn user_message(text: &str) -> Value {
    json!({ "role": "user", "content": text })
}

pub fn assistant_text_message(text: &str) -> Value {
    json!({ "role": "assistant", "content": text })
}

/// Bundle every tool result into one user message. Splitting them across
/// messages teaches the model to stop issuing parallel calls.
pub fn tool_result_message(results: &[(String, String, bool)]) -> Value {
    json!({
        "role": "user",
        "content": results
            .iter()
            .map(|(id, content, is_error)| json!({
                "type": "tool_result",
                "tool_use_id": id,
                "content": content,
                "is_error": is_error,
            }))
            .collect::<Vec<_>>()
    })
}

pub fn parse_turn(resp: &Value) -> Result<Turn, String> {
    if let Some(err) = resp.get("error") {
        return Err(format!(
            "{}: {}",
            err.get("type").and_then(|v| v.as_str()).unwrap_or("api_error"),
            err.get("message").and_then(|v| v.as_str()).unwrap_or("unknown error")
        ));
    }

    let stop_reason = resp.get("stop_reason").and_then(|v| v.as_str()).map(str::to_string);

    if stop_reason.as_deref() == Some("refusal") {
        let detail = resp
            .get("stop_details")
            .and_then(|d| d.get("explanation"))
            .and_then(|v| v.as_str())
            .unwrap_or("the model declined this request");
        return Err(format!("Request declined: {detail}"));
    }

    let content = resp
        .get("content")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "malformed response: no content array".to_string())?;

    let mut text = String::new();
    let mut calls = Vec::new();
    for block in content {
        match block.get("type").and_then(|v| v.as_str()) {
            Some("text") => {
                if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                    text.push_str(t);
                }
            }
            Some("tool_use") => calls.push(ToolCall {
                id: block.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                name: block.get("name").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                input: block.get("input").cloned().unwrap_or_else(|| json!({})),
            }),
            _ => {} // thinking blocks are preserved via `assistant` below
        }
    }

    let usage = resp.get("usage").map(|u| Usage {
        input_tokens: u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
        output_tokens: u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
    });

    Ok(Turn {
        text,
        calls,
        // Echo the full content array so thinking blocks survive the round trip.
        assistant: json!({ "role": "assistant", "content": content }),
        stop_reason,
        usage,
    })
}
