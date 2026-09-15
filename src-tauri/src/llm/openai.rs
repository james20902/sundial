//! OpenAI-compatible chat-completions wire format.
//!
//! Covers OpenAI itself and the many servers that copy its shape — Ollama,
//! LM Studio, vLLM, OpenRouter — which is what makes "run the analysis against
//! a local model" possible without another provider implementation. Point
//! `baseUrl` at the server; local servers usually ignore the API key.

use super::{ProviderConfig, ToolCall, Turn, Usage};
use serde_json::{json, Value};

pub const DEFAULT_MODEL: &str = "gpt-4o-mini";
pub const DEFAULT_BASE: &str = "https://api.openai.com/v1";

pub fn endpoint(cfg: &ProviderConfig) -> String {
    let base = cfg.base_url.as_deref().unwrap_or(DEFAULT_BASE).trim_end_matches('/');
    format!("{base}/chat/completions")
}

pub fn headers(api_key: &str) -> Vec<(&'static str, String)> {
    let mut h = vec![("content-type", "application/json".to_string())];
    if !api_key.is_empty() {
        h.push(("authorization", format!("Bearer {api_key}")));
    }
    h
}

/// Translate the shared tool schemas into the `function` envelope.
fn to_functions(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .map(|t| {
            json!({
                "type": "function",
                "function": {
                    "name": t.get("name").cloned().unwrap_or(Value::Null),
                    "description": t.get("description").cloned().unwrap_or(Value::Null),
                    "parameters": t.get("input_schema").cloned().unwrap_or_else(|| json!({"type": "object"})),
                }
            })
        })
        .collect()
}

pub fn build_body(
    cfg: &ProviderConfig,
    system: &str,
    messages: &[Value],
    tools: &[Value],
) -> Value {
    let mut msgs = vec![json!({ "role": "system", "content": system })];
    msgs.extend(messages.iter().cloned());
    json!({
        "model": cfg.model,
        "max_tokens": cfg.max_tokens,
        "tools": to_functions(tools),
        "messages": msgs,
    })
}

pub fn user_message(text: &str) -> Value {
    json!({ "role": "user", "content": text })
}

pub fn assistant_text_message(text: &str) -> Value {
    json!({ "role": "assistant", "content": text })
}

/// This format wants one message per tool result, unlike Anthropic's single
/// bundled user message.
pub fn tool_result_messages(results: &[(String, String, bool)]) -> Vec<Value> {
    results
        .iter()
        .map(|(id, content, _)| json!({ "role": "tool", "tool_call_id": id, "content": content }))
        .collect()
}

pub fn parse_turn(resp: &Value) -> Result<Turn, String> {
    if let Some(err) = resp.get("error") {
        return Err(err
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown API error")
            .to_string());
    }

    let choice = resp
        .get("choices")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| "malformed response: no choices".to_string())?;
    let message = choice
        .get("message")
        .ok_or_else(|| "malformed response: no message".to_string())?;

    let text = message.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let mut calls = Vec::new();
    if let Some(tcs) = message.get("tool_calls").and_then(|v| v.as_array()) {
        for tc in tcs {
            let f = tc.get("function");
            // Arguments arrive as a JSON *string*; never pattern-match it raw.
            let input = f
                .and_then(|f| f.get("arguments"))
                .and_then(|v| v.as_str())
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .unwrap_or_else(|| json!({}));
            calls.push(ToolCall {
                id: tc.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                name: f
                    .and_then(|f| f.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                input,
            });
        }
    }

    let usage = resp.get("usage").map(|u| Usage {
        input_tokens: u.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
        output_tokens: u.get("completion_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
    });

    Ok(Turn {
        text,
        calls,
        assistant: message.clone(),
        stop_reason: choice.get("finish_reason").and_then(|v| v.as_str()).map(str::to_string),
        usage,
    })
}
