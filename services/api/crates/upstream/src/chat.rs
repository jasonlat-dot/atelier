//! Text-only OpenAI SSE adapter; framing adapted from ShellPilot provider/stream.rs.
use crate::{
    egress::{GuardedResponse, Payload, SafeHttp},
    provider::{classify, ProviderAccount},
    Error, RouteLease, UpstreamService,
};
use atelier_agent_core::{ChatRequest, CoreError, CoreFuture, LlmClient, TokenStream};
use serde_json::{json, Value};
use std::{collections::VecDeque, time::Duration};
#[derive(Default)]
struct Frames {
    line: Vec<u8>,
    data: String,
}
impl Frames {
    fn feed(&mut self, bytes: &[u8]) -> Result<Vec<String>, CoreError> {
        let mut frames = Vec::new();
        for &byte in bytes {
            if byte != b'\n' {
                self.line.push(byte);
                if self.line.len() > 65536 {
                    return Err(CoreError::Invalid);
                }
                continue;
            }
            let line = std::mem::take(&mut self.line);
            let line = std::str::from_utf8(line.strip_suffix(b"\r").unwrap_or(&line))
                .map_err(|_| CoreError::Invalid)?;
            if line.is_empty() {
                if !self.data.is_empty() {
                    self.data.pop();
                    frames.push(std::mem::take(&mut self.data));
                }
            } else if let Some(data) = line.strip_prefix("data:") {
                self.data.push_str(data.strip_prefix(' ').unwrap_or(data));
                self.data.push('\n');
                if self.data.len() > 65536 {
                    return Err(CoreError::Invalid);
                }
            }
        }
        Ok(frames)
    }
}
pub(crate) async fn open(
    http: &SafeHttp,
    account: &ProviderAccount,
    input: &ChatRequest,
) -> Result<GuardedResponse, Error> {
    if input.messages.len() > 205
        || input
            .messages
            .iter()
            .map(|m| m.content.len())
            .sum::<usize>()
            > 512 * 1024
        || !(1..=8192).contains(&input.max_output_tokens)
    {
        return Err(Error::Validation);
    }
    let body = json!({"model":account.upstream_model,"messages":input.messages.iter().map(|m|json!({"role":m.role,"content":m.content})).collect::<Vec<_>>(),"stream":true,"n":1,"max_tokens":input.max_output_tokens});
    let mut response = http
        .for_endpoint(&account.base_url)?
        .open_stream(
            reqwest::Method::POST,
            &format!(
                "{}/chat/completions",
                account.base_url.trim_end_matches('/')
            ),
            Some(&account.secret),
            Payload::Json(body),
            Duration::from_secs(180),
            2 * 1024 * 1024,
        )
        .await?;
    if response.status() != 200 {
        let status = response.status();
        let retry = response.retry_after();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if bytes.len() + chunk.len() > 65536 {
                break;
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        return Err(Error::Provider(
            classify(status, &value, retry).unwrap_or_else(crate::ProviderFailure::network),
        ));
    }
    if response.content_type() != "text/event-stream" {
        return Err(Error::Provider(crate::ProviderFailure::network()));
    }
    Ok(response)
}
struct State {
    lease: Option<RouteLease>,
    response: GuardedResponse,
    parser: Frames,
    pending: VecDeque<String>,
    finished: bool,
    has_text: bool,
    bytes: usize,
}
pub(crate) fn stream(lease: RouteLease, response: GuardedResponse) -> TokenStream {
    Box::pin(futures_util::stream::try_unfold(
        State {
            lease: Some(lease),
            response,
            parser: Frames::default(),
            pending: VecDeque::new(),
            finished: false,
            has_text: false,
            bytes: 0,
        },
        |mut state| async move {
            loop {
                if !state.lease.as_ref().is_some_and(RouteLease::is_valid) {
                    return Err(CoreError::Unavailable);
                }
                if let Some(frame) = state.pending.pop_front() {
                    if frame == "[DONE]" {
                        if !state.finished || !state.has_text {
                            return Err(CoreError::Invalid);
                        }
                        state
                            .lease
                            .take()
                            .ok_or(CoreError::Unavailable)?
                            .finish_success(1, "chat")
                            .await
                            .map_err(|_| CoreError::Unavailable)?;
                        return Ok(None);
                    }
                    let data: Value =
                        serde_json::from_str(&frame).map_err(|_| CoreError::Invalid)?;
                    if !data["error"].is_null() {
                        return Err(CoreError::Unavailable);
                    }
                    let choices = data["choices"].as_array().ok_or(CoreError::Invalid)?;
                    if choices.is_empty() && state.finished && data["usage"].is_object() {
                        continue;
                    }
                    if choices.len() != 1 || choices[0]["index"].as_u64() != Some(0) {
                        return Err(CoreError::Invalid);
                    }
                    let choice = &choices[0];
                    let delta = &choice["delta"];
                    if !delta["tool_calls"].is_null()
                        || !delta["function_call"].is_null()
                        || !delta["refusal"].is_null()
                    {
                        return Err(CoreError::Invalid);
                    }
                    if !choice["finish_reason"].is_null() {
                        if choice["finish_reason"] != "stop" {
                            return Err(CoreError::Invalid);
                        }
                        state.finished = true;
                    }
                    if let Some(text) = delta["content"].as_str().filter(|s| !s.is_empty()) {
                        state.bytes += text.len();
                        if state.bytes > 65536 {
                            return Err(CoreError::Invalid);
                        }
                        state.has_text = true;
                        return Ok(Some((text.to_owned(), state)));
                    }
                } else {
                    let chunk = state
                        .response
                        .chunk()
                        .await
                        .map_err(|_| CoreError::Unavailable)?
                        .ok_or(CoreError::Invalid)?;
                    state.pending.extend(state.parser.feed(&chunk)?);
                }
            }
        },
    ))
}
#[derive(Clone)]
pub struct ModelClient {
    service: UpstreamService,
    model: String,
}
impl UpstreamService {
    pub fn text_client(&self, model: &str) -> ModelClient {
        ModelClient {
            service: self.clone(),
            model: model.into(),
        }
    }
}
impl LlmClient for ModelClient {
    fn stream(&self, req: ChatRequest) -> CoreFuture<'_, TokenStream> {
        Box::pin(async move {
            let lease = self
                .service
                .acquire(
                    &self.model,
                    &crate::RouteRequirements {
                        quality: "message".into(),
                        ratio: String::new(),
                        resolution: "text".into(),
                        n: 1,
                        reference_count: 0,
                        seconds: None,
                    },
                )
                .await
                .map_err(|_| CoreError::Unavailable)?;
            let response = match lease.open_chat(&req).await {
                Ok(response) => response,
                Err(Error::Provider(failure)) => {
                    let _ = lease.finish_failure(failure, "chat").await;
                    return Err(CoreError::Unavailable);
                }
                Err(_) => return Err(CoreError::Unavailable),
            };
            Ok(stream(lease, response))
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sse_preserves_split_utf8_and_bounds_lines() {
        let bytes = "data: {\"text\":\"海浪\"}\r\n\r\n".as_bytes();
        let mut parser = Frames::default();
        let mut frames = Vec::new();
        for byte in bytes {
            frames.extend(parser.feed(&[*byte]).unwrap());
        }
        assert_eq!(frames, vec!["{\"text\":\"海浪\"}"]);
        assert!(parser.feed(&vec![b'x'; 65537]).is_err());
    }
}
