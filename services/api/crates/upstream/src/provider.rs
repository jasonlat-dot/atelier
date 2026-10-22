//! OpenAI-compatible wire adapters; internal results contain bytes, never URLs.
use crate::{
    egress::{Payload, Response, SafeHttp},
    Error, FailureCode, ProviderFailure,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use bytes::Bytes;
use reqwest::{
    multipart::{Form, Part},
    Method,
};
use serde_json::{json, Value};
use std::{future::Future, pin::Pin, time::Duration};
use zeroize::Zeroizing;

pub struct ProviderAccount {
    pub base_url: String,
    pub secret: Zeroizing<String>,
    pub upstream_model: String,
}
#[derive(Clone)]
pub struct ReferenceImage {
    pub bytes: Bytes,
    pub mime: String,
}
#[derive(Clone)]
pub struct ImageRequest {
    pub prompt: String,
    pub quality: String,
    pub ratio: String,
    pub resolution: String,
    pub n: u8,
    pub references: Vec<ReferenceImage>,
}
#[derive(Clone)]
pub struct VideoRequest {
    pub prompt: String,
    pub ratio: String,
    pub resolution: String,
    pub seconds: u32,
    pub reference: Option<ReferenceImage>,
}
pub struct MediaOutput {
    pub bytes: Bytes,
    pub mime: String,
}
pub enum VideoStatus {
    Pending(u8),
    Complete,
}
pub type ProviderFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, Error>> + Send + 'a>>;
pub trait Provider: Send + Sync {
    fn probe<'a>(&'a self, account: &'a ProviderAccount) -> ProviderFuture<'a, ()>;
    fn images<'a>(
        &'a self,
        account: &'a ProviderAccount,
        input: &'a ImageRequest,
        size: &'a str,
    ) -> ProviderFuture<'a, Vec<MediaOutput>>;
    fn submit_video<'a>(
        &'a self,
        account: &'a ProviderAccount,
        input: &'a VideoRequest,
        size: &'a str,
    ) -> ProviderFuture<'a, String>;
    fn poll_video<'a>(
        &'a self,
        account: &'a ProviderAccount,
        id: &'a str,
    ) -> ProviderFuture<'a, VideoStatus>;
    fn video_content<'a>(
        &'a self,
        account: &'a ProviderAccount,
        id: &'a str,
    ) -> ProviderFuture<'a, MediaOutput>;
}
#[derive(Clone)]
pub struct OpenAiCompatible {
    http: SafeHttp,
}
impl OpenAiCompatible {
    pub fn new(http: SafeHttp) -> Self {
        Self { http }
    }
}
fn endpoint(base: &str, path: &str) -> String {
    format!("{}/{path}", base.trim_end_matches('/'))
}
fn network() -> Error {
    Error::Provider(ProviderFailure::network())
}
fn produced(mut failure: ProviderFailure) -> Error {
    failure.produced = true;
    Error::Provider(failure)
}
pub fn classify(status: u16, body: &Value, retry_after: Option<u64>) -> Option<ProviderFailure> {
    let error = body.get("error").filter(|v| !v.is_null());
    let code = error
        .and_then(|e| e.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let kind = error
        .and_then(|e| e.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let quota = matches!(
        code,
        "insufficient_quota" | "quota_exceeded" | "billing_hard_limit_reached"
    ) || kind == "insufficient_quota";
    let code = if matches!(
        code,
        "content_policy_violation"
            | "moderation_blocked"
            | "content_filter"
            | "safety_violation"
            | "content_policy"
    ) || kind == "content_policy_violation"
    {
        FailureCode::ContentPolicy
    } else if status == 401 || status == 403 || code == "invalid_api_key" {
        FailureCode::AccountInvalid
    } else if status == 429 || quota {
        FailureCode::RateLimited
    } else if status >= 500 || matches!(status, 408 | 425) {
        FailureCode::UpstreamError
    } else if !(200..300).contains(&status) || error.is_some() {
        FailureCode::BadRequest
    } else {
        return None;
    };
    Some(ProviderFailure {
        code,
        retry_after,
        quota_exhausted: quota,
        produced: false,
    })
}
fn json_response(response: Response) -> Result<Value, Error> {
    let parsed = serde_json::from_slice::<Value>(&response.body);
    let value = parsed.as_ref().unwrap_or(&Value::Null);
    if let Some(failure) = classify(response.status, value, response.retry_after) {
        return Err(Error::Provider(failure));
    }
    parsed.map_err(|_| network())
}
fn reference(reference: &ReferenceImage) -> Result<(), Error> {
    if reference.bytes.is_empty()
        || reference.bytes.len() > 20 * 1024 * 1024
        || image_mime(&reference.bytes) != Some(reference.mime.as_str())
    {
        return Err(Error::Validation);
    }
    Ok(())
}
fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}
fn video_id(id: &str) -> Result<(), Error> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err(network());
    }
    Ok(())
}
impl Provider for OpenAiCompatible {
    fn probe<'a>(&'a self, account: &'a ProviderAccount) -> ProviderFuture<'a, ()> {
        Box::pin(async move {
            let response = self
                .http
                .send(
                    Method::GET,
                    &endpoint(&account.base_url, "models"),
                    Some(&account.secret),
                    Payload::Empty,
                    Duration::from_secs(10),
                    1024 * 1024,
                )
                .await?;
            let body = json_response(response)?;
            if body.get("data").and_then(Value::as_array).is_none() {
                return Err(network());
            }
            Ok(())
        })
    }
    fn images<'a>(
        &'a self,
        account: &'a ProviderAccount,
        input: &'a ImageRequest,
        size: &'a str,
    ) -> ProviderFuture<'a, Vec<MediaOutput>> {
        Box::pin(async move {
            let editing = !input.references.is_empty();
            let payload = if editing {
                let mut form = Form::new()
                    .text("model", account.upstream_model.clone())
                    .text("prompt", input.prompt.clone())
                    .text("n", input.n.to_string())
                    .text("quality", input.quality.clone())
                    .text("size", size.to_string())
                    .text("moderation", "auto");
                for (index, image) in input.references.iter().enumerate() {
                    reference(image)?;
                    let part = Part::bytes(image.bytes.to_vec())
                        .file_name(format!(
                            "reference-{index}.{}",
                            if image.mime == "image/png" {
                                "png"
                            } else if image.mime == "image/jpeg" {
                                "jpg"
                            } else {
                                "webp"
                            }
                        ))
                        .mime_str(&image.mime)
                        .map_err(|_| Error::Validation)?;
                    form = form.part("image[]", part);
                }
                Payload::Multipart(form)
            } else {
                Payload::Json(
                    json!({"model":account.upstream_model,"prompt":input.prompt,"n":input.n,"quality":input.quality,"size":size,"moderation":"auto"}),
                )
            };
            let timeout = if input.quality == "high" || input.resolution != "1K" {
                310
            } else {
                130
            };
            let response = self
                .http
                .send(
                    Method::POST,
                    &endpoint(
                        &account.base_url,
                        if editing {
                            "images/edits"
                        } else {
                            "images/generations"
                        },
                    ),
                    Some(&account.secret),
                    payload,
                    Duration::from_secs(timeout),
                    128 * 1024 * 1024,
                )
                .await?;
            let body = json_response(response)?;
            let data = body
                .get("data")
                .and_then(Value::as_array)
                .ok_or_else(network)?;
            if data.is_empty() || data.len() > input.n as usize {
                return Err(network());
            }
            let mut outputs = Vec::new();
            for item in data {
                let output = async {
                    let bytes = if let Some(encoded) = item.get("b64_json").and_then(Value::as_str)
                    {
                        if encoded.len() > 28 * 1024 * 1024 {
                            return Err(network());
                        }
                        Bytes::from(STANDARD.decode(encoded).map_err(|_| network())?)
                    } else if let Some(url) = item.get("url").and_then(Value::as_str) {
                        let response = self
                            .http
                            .send(
                                Method::GET,
                                url,
                                None,
                                Payload::Empty,
                                Duration::from_secs(30),
                                20 * 1024 * 1024,
                            )
                            .await?;
                        if !(200..300).contains(&response.status) {
                            return Err(network());
                        }
                        response.body
                    } else {
                        return Err(network());
                    };
                    if bytes.len() > 20 * 1024 * 1024 {
                        return Err(network());
                    }
                    let mime = image_mime(&bytes).ok_or_else(network)?;
                    Ok::<_, Error>(MediaOutput {
                        bytes,
                        mime: mime.into(),
                    })
                }
                .await;
                // Once a provider produced anything, a bad/partial download must not
                // submit a second paid generation. M5 can settle only usable outputs.
                if let Ok(output) = output {
                    outputs.push(output);
                }
            }
            if outputs.is_empty() {
                return Err(produced(ProviderFailure::network()));
            }
            Ok(outputs)
        })
    }
    fn submit_video<'a>(
        &'a self,
        account: &'a ProviderAccount,
        input: &'a VideoRequest,
        size: &'a str,
    ) -> ProviderFuture<'a, String> {
        Box::pin(async move {
            let mut body = json!({"model":account.upstream_model,"prompt":input.prompt,"seconds":input.seconds.to_string(),"size":size});
            if let Some(image) = &input.reference {
                reference(image)?;
                body["input_reference"] = json!({"image_url":format!("data:{};base64,{}",image.mime,STANDARD.encode(&image.bytes))});
            }
            let response = self
                .http
                .send(
                    Method::POST,
                    &endpoint(&account.base_url, "videos"),
                    Some(&account.secret),
                    Payload::Json(body),
                    Duration::from_secs(30),
                    1024 * 1024,
                )
                .await?;
            let body = json_response(response)?;
            let id = body.get("id").and_then(Value::as_str).ok_or_else(network)?;
            video_id(id)?;
            Ok(id.to_owned())
        })
    }
    fn poll_video<'a>(
        &'a self,
        account: &'a ProviderAccount,
        id: &'a str,
    ) -> ProviderFuture<'a, VideoStatus> {
        Box::pin(async move {
            video_id(id)?;
            let response = self
                .http
                .send(
                    Method::GET,
                    &endpoint(&account.base_url, &format!("videos/{id}")),
                    Some(&account.secret),
                    Payload::Empty,
                    Duration::from_secs(10),
                    1024 * 1024,
                )
                .await?;
            let body = json_response(response)?;
            if body.get("id").and_then(Value::as_str) != Some(id) {
                return Err(network());
            }
            match body.get("status").and_then(Value::as_str) {
                Some("completed") => Ok(VideoStatus::Complete),
                Some("queued" | "in_progress") => Ok(VideoStatus::Pending(
                    body.get("progress")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        .min(100) as u8,
                )),
                Some("failed") => Err(network()),
                _ => Err(network()),
            }
        })
    }
    fn video_content<'a>(
        &'a self,
        account: &'a ProviderAccount,
        id: &'a str,
    ) -> ProviderFuture<'a, MediaOutput> {
        Box::pin(async move {
            video_id(id)?;
            let response = self
                .http
                .send(
                    Method::GET,
                    &endpoint(&account.base_url, &format!("videos/{id}/content")),
                    Some(&account.secret),
                    Payload::Empty,
                    Duration::from_secs(30),
                    200 * 1024 * 1024,
                )
                .await?;
            if !(200..300).contains(&response.status) {
                return Err(Error::Provider(
                    classify(
                        response.status,
                        &serde_json::from_slice(&response.body).unwrap_or(Value::Null),
                        response.retry_after,
                    )
                    .unwrap_or_else(ProviderFailure::network),
                ));
            }
            let bytes = if response.content_type == "application/json" {
                let body: Value = serde_json::from_slice(&response.body).map_err(|_| network())?;
                let url = body
                    .get("url")
                    .and_then(Value::as_str)
                    .ok_or_else(network)?;
                let download = self
                    .http
                    .send(
                        Method::GET,
                        url,
                        None,
                        Payload::Empty,
                        Duration::from_secs(30),
                        200 * 1024 * 1024,
                    )
                    .await?;
                if download.status != 200 {
                    return Err(network());
                }
                download.body
            } else {
                response.body
            };
            let mp4 = bytes.len() > 12 && &bytes[4..8] == b"ftyp";
            let webm = bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]);
            if !mp4 && !webm {
                return Err(network());
            }
            Ok(MediaOutput {
                bytes,
                mime: if mp4 { "video/mp4" } else { "video/webm" }.into(),
            })
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn errors_are_classified_without_exposing_provider_messages() {
        for (status, code) in [
            (401, FailureCode::AccountInvalid),
            (403, FailureCode::AccountInvalid),
            (429, FailureCode::RateLimited),
            (500, FailureCode::UpstreamError),
            (408, FailureCode::UpstreamError),
            (422, FailureCode::BadRequest),
        ] {
            assert_eq!(classify(status, &json!({}), None).unwrap().code, code);
        }
        assert_eq!(classify(400,&json!({"error":{"code":"content_policy_violation","message":"private provider detail"}}),None).unwrap().code,FailureCode::ContentPolicy);
        assert!(
            classify(429, &json!({"error":{"code":"insufficient_quota"}}), None)
                .unwrap()
                .quota_exhausted
        );
        assert!(classify(200, &json!({"data":[]}), None).is_none());
    }
}
