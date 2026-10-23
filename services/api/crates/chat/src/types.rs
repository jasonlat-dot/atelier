use atelier_agent_core::Intent;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{future::Future, pin::Pin, sync::Arc};
use utoipa::ToSchema;
use uuid::Uuid;
pub type Authorization = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ConversationInput {
    pub title: String,
}
#[derive(Clone, Serialize, ToSchema, sqlx::FromRow)]
pub struct Conversation {
    pub id: Uuid,
    pub title: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
#[derive(Serialize, ToSchema)]
pub struct ConversationPage {
    pub items: Vec<Conversation>,
    pub next_cursor: Option<Uuid>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SendMessage {
    pub model_id: String,
    pub content: String,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct CanvasDraft {
    pub prompt: String,
    pub quality: String,
    pub ratio: String,
    pub resolution: String,
    pub n: u8,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct CanvasAction {
    pub r#type: String,
    pub draft: CanvasDraft,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct ChatTurn {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub model_id: String,
    pub content: String,
    pub reply: String,
    pub status: String,
    pub cost: i64,
    pub charged: i64,
    pub intent: Option<Intent>,
    pub action: Option<CanvasAction>,
    pub error_code: Option<String>,
    pub estimated_tokens: i32,
    pub created_at: DateTime<Utc>,
}
#[derive(Serialize, ToSchema)]
pub struct ConversationView {
    pub conversation: Conversation,
    pub turns: Vec<ChatTurn>,
    pub next_cursor: Option<Uuid>,
    pub summary: String,
    pub context_window: i64,
    pub estimated_tokens: i64,
}
#[derive(Serialize, ToSchema, sqlx::FromRow)]
pub struct ChatModel {
    pub id: String,
    pub display_name: String,
}
#[derive(Serialize, ToSchema)]
pub struct ChatConfig {
    pub models: Vec<ChatModel>,
    pub credits_per_message: i64,
    pub context_window: i64,
    pub output_tokens: i64,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct ChatDelta {
    pub turn_id: Uuid,
    pub text: String,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct ChatFailure {
    pub turn_id: Uuid,
    pub code: String,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "event", content = "data", rename_all = "lowercase")]
pub enum ChatEvent {
    Delta(ChatDelta),
    Intent(Intent),
    Action(CanvasAction),
    Done(ChatTurn),
    Error(ChatFailure),
}
pub enum Start {
    Replay(Box<ChatTurn>),
    Running { turn: Uuid, token: Uuid },
}
