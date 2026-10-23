//! Provider-independent text reasoning, intent routing and bounded context compaction.
//! Budget estimation and evidence-preserving summary validation adapted from ShellPilot
//! agent/{budget,compact}.rs (Apache-2.0). No terminal, SSH, filesystem or execution tools.
mod context;
mod intent;
pub use context::{estimate_text, should_compress, EvidenceCompressor};
pub use intent::CreativeClassifier;
use serde::{Deserialize, Serialize};
use std::{future::Future, pin::Pin};
use utoipa::ToSchema;
pub type CoreFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, CoreError>> + Send + 'a>>;
pub type TokenStream = Pin<Box<dyn futures_util::Stream<Item = Result<String, CoreError>> + Send>>;
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("Language content rejected")]
    ContentPolicy,
    #[error("Language service unavailable")]
    Unavailable,
    #[error("Language output is invalid or exceeds limits")]
    Invalid,
    #[error("Context exceeds the configured budget")]
    Budget,
}
#[derive(Clone, Serialize, Deserialize, Debug, ToSchema)]
pub struct Message {
    pub id: i64,
    pub role: String,
    pub content: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub messages: Vec<Message>,
    pub max_output_tokens: u32,
}
#[derive(Clone)]
pub struct ConversationView {
    pub messages: Vec<Message>,
    pub summary: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Intent {
    Chat,
    ImageGenerate,
    ImageEdit,
    PromptRefine,
    CanvasAssist,
    Unsafe,
}
#[derive(Clone, Default, Serialize, Deserialize, Debug)]
pub struct Compressed {
    pub summary: String,
    pub retained_facts: Vec<String>,
    pub through_id: i64,
}
pub trait LlmClient: Send + Sync {
    fn stream(&self, req: ChatRequest) -> CoreFuture<'_, TokenStream>;
}
pub trait IntentClassifier: Send + Sync {
    fn classify<'a>(&'a self, ctx: &'a ConversationView) -> CoreFuture<'a, Intent>;
}
pub trait ContextCompressor: Send + Sync {
    fn compress<'a>(
        &'a self,
        msgs: &'a [Message],
        previous: &'a Compressed,
        budget: usize,
    ) -> CoreFuture<'a, Compressed>;
}
