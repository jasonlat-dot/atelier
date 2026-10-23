use crate::*;
use atelier_agent_core::{CreativeClassifier, Intent, IntentClassifier};
use atelier_wallet::{Operation, WalletService};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool, Postgres, Row, Transaction};
use std::sync::Arc;
use uuid::Uuid;
#[derive(Clone)]
pub struct ChatService {
    pub(crate) db: PgPool,
    pub(crate) upstream: atelier_upstream::UpstreamService,
    pub(crate) client: Option<Arc<dyn atelier_agent_core::LlmClient>>,
}
pub(crate) fn title(value: &str) -> Result<String, ChatError> {
    let s = value.trim();
    if s.is_empty() || s.chars().count() > 100 || s.chars().any(char::is_control) {
        return Err(ChatError::Validation);
    }
    Ok(s.into())
}
pub(crate) fn turn(row: sqlx::postgres::PgRow) -> Result<ChatTurn, ChatError> {
    let intent: Option<String> = row.get("intent");
    let action: Option<serde_json::Value> = row.get("action");
    Ok(ChatTurn {
        id: row.get("id"),
        conversation_id: row.get("conversation_id"),
        model_id: row.get("model_id"),
        content: row.get("content"),
        reply: row.get("reply"),
        status: row.get("status"),
        cost: row.get("cost"),
        charged: if row.get::<String, _>("status") == "SUCCEEDED" {
            row.get("cost")
        } else {
            0
        },
        intent: intent
            .map(|s| {
                serde_json::from_value(serde_json::Value::String(s)).map_err(|_| ChatError::Store)
            })
            .transpose()?,
        action: action
            .map(|v| serde_json::from_value(v).map_err(|_| ChatError::Store))
            .transpose()?,
        error_code: row.get("error_code"),
        estimated_tokens: row.get("estimated_tokens"),
        created_at: row.get("created_at"),
    })
}
pub(crate) async fn audit(
    db: &mut PgConnection,
    owner: Uuid,
    action: &str,
    id: Uuid,
) -> Result<(), ChatError> {
    sqlx::query("INSERT INTO audit_logs(actor_id,action,target_type,target_id) VALUES($1,$2,'conversation',$3)").bind(owner).bind(action).bind(id.to_string()).execute(db).await?;
    Ok(())
}
impl ChatService {
    /// Stop private work without exposing its messages to an administrator.
    pub async fn cancel_owner_in_transaction(
        db: &mut PgConnection,
        owner: Uuid,
    ) -> Result<usize, ChatError> {
        let rows=sqlx::query("SELECT id,cost FROM chat_turns WHERE owner_id=$1 AND status='RUNNING' ORDER BY id FOR UPDATE").bind(owner).fetch_all(&mut *db).await?;
        for row in &rows {
            let id: Uuid = row.get("id");
            let cost: i64 = row.get("cost");
            if cost > 0 {
                WalletService::apply_in_transaction(
                    db,
                    owner,
                    Operation::Release {
                        job: id,
                        amount: cost,
                    },
                )
                .await?;
            }
            sqlx::query("UPDATE chat_turns SET status='CANCELLED',cancel_requested=true,error_code='ACCOUNT_DISABLED',finished_at=clock_timestamp() WHERE id=$1").bind(id).execute(&mut *db).await?;
        }
        Ok(rows.len())
    }
    pub fn new(db: PgPool, upstream: atelier_upstream::UpstreamService) -> Self {
        Self {
            db,
            upstream,
            client: None,
        }
    }
    pub fn with_client(mut self, client: Arc<dyn atelier_agent_core::LlmClient>) -> Self {
        self.client = Some(client);
        self
    }
    pub(crate) async fn owner_tx(
        &self,
        owner: Uuid,
    ) -> Result<Transaction<'static, Postgres>, ChatError> {
        let mut tx = self.db.begin().await?;
        let id: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM users WHERE id=$1 AND status='ACTIVE' FOR UPDATE")
                .bind(owner)
                .fetch_optional(&mut *tx)
                .await?;
        if id.is_none() {
            return Err(ChatError::NotFound);
        }
        Ok(tx)
    }
    pub async fn config(&self) -> Result<ChatConfig, ChatError> {
        let settings:Vec<(String,serde_json::Value)>=sqlx::query_as("SELECT key,value FROM system_settings WHERE key IN ('chat_credits_per_message','chat_context_window','chat_output_tokens')").fetch_all(&self.db).await?;
        let get = |key: &str, min: i64, max: i64| {
            settings
                .iter()
                .find(|(k, _)| k == key)
                .and_then(|(_, v)| v.as_i64())
                .filter(|n| (min..=max).contains(n))
                .ok_or(ChatError::Store)
        };
        let models=sqlx::query_as("SELECT id,display_name FROM models WHERE enabled AND kind='chat' ORDER BY sort_order,id").fetch_all(&self.db).await?;
        Ok(ChatConfig {
            models,
            credits_per_message: get("chat_credits_per_message", 0, 10000)?,
            context_window: get("chat_context_window", 2048, 131072)?,
            output_tokens: get("chat_output_tokens", 128, 8192)?,
        })
    }
    pub async fn create(
        &self,
        owner: Uuid,
        key: Uuid,
        input: ConversationInput,
    ) -> Result<Conversation, ChatError> {
        if key.is_nil() {
            return Err(ChatError::Validation);
        }
        let title = title(&input.title)?;
        let hash = Sha256::digest(title.as_bytes()).to_vec();
        let mut tx = self.owner_tx(owner).await?;
        let old:Option<(Uuid,Vec<u8>)>=sqlx::query_as("SELECT id,create_hash FROM conversations WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL").bind(key).bind(owner).fetch_optional(&mut *tx).await?;
        if let Some((_, old)) = old {
            if old != hash {
                return Err(ChatError::Conflict);
            }
            tx.commit().await?;
            return self.conversation(owner, key).await;
        }
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM conversations WHERE owner_id=$1 AND deleted_at IS NULL",
        )
        .bind(owner)
        .fetch_one(&mut *tx)
        .await?;
        if count >= 1000 {
            return Err(ChatError::Validation);
        }
        sqlx::query("INSERT INTO conversations(id,owner_id,title,create_hash) VALUES($1,$2,$3,$4)")
            .bind(key)
            .bind(owner)
            .bind(title)
            .bind(hash)
            .execute(&mut *tx)
            .await?;
        audit(&mut tx, owner, "chat.create", key).await?;
        tx.commit().await?;
        self.conversation(owner, key).await
    }
    pub async fn list(
        &self,
        owner: Uuid,
        before: Option<Uuid>,
    ) -> Result<ConversationPage, ChatError> {
        let mut items:Vec<Conversation>=sqlx::query_as("SELECT id,title,created_at,updated_at FROM conversations WHERE owner_id=$1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR (updated_at,id)<(SELECT updated_at,id FROM conversations WHERE owner_id=$1 AND id=$2)) ORDER BY updated_at DESC,id DESC LIMIT 26").bind(owner).bind(before).fetch_all(&self.db).await?;
        let next_cursor = if items.len() > 25 {
            items.truncate(25);
            items.last().map(|c| c.id)
        } else {
            None
        };
        Ok(ConversationPage { items, next_cursor })
    }
    pub async fn conversation(&self, owner: Uuid, id: Uuid) -> Result<Conversation, ChatError> {
        sqlx::query_as("SELECT id,title,created_at,updated_at FROM conversations WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL").bind(owner).bind(id).fetch_optional(&self.db).await?.ok_or(ChatError::NotFound)
    }
    pub async fn get(
        &self,
        owner: Uuid,
        id: Uuid,
        before: Option<Uuid>,
    ) -> Result<ConversationView, ChatError> {
        let conversation = self.conversation(owner, id).await?;
        let config = self.config().await?;
        let rows=sqlx::query("SELECT t.*,u.content,a.content AS reply FROM chat_turns t JOIN chat_messages u ON u.turn_id=t.id AND u.role='user' JOIN chat_messages a ON a.turn_id=t.id AND a.role='assistant' WHERE t.owner_id=$1 AND t.conversation_id=$2 AND ($3::uuid IS NULL OR (t.created_at,t.id)<(SELECT created_at,id FROM chat_turns WHERE id=$3 AND owner_id=$1 AND conversation_id=$2)) ORDER BY t.created_at DESC,t.id DESC LIMIT 51").bind(owner).bind(id).bind(before).fetch_all(&self.db).await?;
        let mut turns = rows.into_iter().map(turn).collect::<Result<Vec<_>, _>>()?;
        let next_cursor = if turns.len() > 50 {
            turns.truncate(50);
            turns.last().map(|t| t.id)
        } else {
            None
        };
        turns.reverse();
        let (summary,estimated):(String,i64)=sqlx::query_as("SELECT summary,coalesce((SELECT sum((octet_length(content)+2)/3+12) FROM chat_messages m JOIN chat_turns t ON t.id=m.turn_id WHERE m.conversation_id=c.id AND m.id>c.summary_through AND t.status='SUCCEEDED'),0)::bigint+(octet_length(summary)+octet_length(retained_facts::text))/3+512 FROM conversations c WHERE c.id=$1 AND c.owner_id=$2").bind(id).bind(owner).fetch_one(&self.db).await?;
        Ok(ConversationView {
            conversation,
            turns,
            next_cursor,
            summary,
            context_window: config.context_window,
            estimated_tokens: estimated,
        })
    }
    pub async fn rename(
        &self,
        owner: Uuid,
        id: Uuid,
        input: ConversationInput,
    ) -> Result<Conversation, ChatError> {
        let title = title(&input.title)?;
        let mut tx = self.owner_tx(owner).await?;
        let updated=sqlx::query("UPDATE conversations SET title=$3,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL").bind(id).bind(owner).bind(title).execute(&mut *tx).await?;
        if updated.rows_affected() != 1 {
            return Err(ChatError::NotFound);
        }
        audit(&mut tx, owner, "chat.rename", id).await?;
        tx.commit().await?;
        self.conversation(owner, id).await
    }
    pub async fn delete(&self, owner: Uuid, id: Uuid) -> Result<(), ChatError> {
        let mut tx = self.owner_tx(owner).await?;
        let updated=sqlx::query("UPDATE conversations SET deleted_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL").bind(id).bind(owner).execute(&mut *tx).await?;
        if updated.rows_affected() != 1 {
            return Err(ChatError::NotFound);
        }
        sqlx::query("UPDATE chat_turns SET cancel_requested=true WHERE conversation_id=$1 AND owner_id=$2 AND status='RUNNING'").bind(id).bind(owner).execute(&mut *tx).await?;
        audit(&mut tx, owner, "chat.delete", id).await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn turn(&self, owner: Uuid, id: Uuid) -> Result<ChatTurn, ChatError> {
        let row=sqlx::query("SELECT t.*,u.content,a.content AS reply FROM chat_turns t JOIN chat_messages u ON u.turn_id=t.id AND u.role='user' JOIN chat_messages a ON a.turn_id=t.id AND a.role='assistant' WHERE t.owner_id=$1 AND t.id=$2").bind(owner).bind(id).fetch_optional(&self.db).await?.ok_or(ChatError::NotFound)?;
        turn(row)
    }
    pub async fn start(
        &self,
        owner: Uuid,
        conversation: Uuid,
        key: Uuid,
        mut input: SendMessage,
    ) -> Result<Start, ChatError> {
        input.content = input.content.trim().into();
        if key.is_nil()
            || input.content.is_empty()
            || input.content.chars().count() > 4000
            || input.content.contains('\0')
            || input.model_id.len() > 64
        {
            return Err(ChatError::Validation);
        }
        let hash = Sha256::digest(
            serde_json::to_vec(&(conversation, &input)).map_err(|_| ChatError::Validation)?,
        )
        .to_vec();
        let intent = CreativeClassifier
            .classify(&atelier_agent_core::ConversationView {
                messages: vec![atelier_agent_core::Message {
                    id: 0,
                    role: "user".into(),
                    content: input.content.clone(),
                }],
                summary: String::new(),
            })
            .await
            .map_err(|_| ChatError::Store)?;
        let config = self.config().await?;
        let mut tx = self.owner_tx(owner).await?;
        let exists:Option<Uuid>=sqlx::query_scalar("SELECT id FROM conversations WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE").bind(owner).bind(conversation).fetch_optional(&mut *tx).await?;
        if exists.is_none() {
            return Err(ChatError::NotFound);
        }
        let old: Option<(Uuid, Vec<u8>, String)> = sqlx::query_as(
            "SELECT id,request_hash,status FROM chat_turns WHERE owner_id=$1 AND request_key=$2",
        )
        .bind(owner)
        .bind(key)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some((id, old, status)) = old {
            if old != hash {
                return Err(ChatError::Conflict);
            }
            if status != "SUCCEEDED" {
                return Err(if status == "RUNNING" {
                    ChatError::Busy
                } else {
                    ChatError::Conflict
                });
            }
            tx.commit().await?;
            return Ok(Start::Replay(Box::new(self.turn(owner, id).await?)));
        }
        if intent == Intent::Unsafe {
            sqlx::query("INSERT INTO moderation_violations(user_id,source) VALUES($1,'local')")
                .bind(owner)
                .execute(&mut *tx)
                .await?;
        }
        if intent == Intent::Unsafe
            || atelier_generation::content_is_blocked(&mut tx, owner, &input.content)
                .await
                .map_err(|_| ChatError::Store)?
        {
            tx.commit().await?;
            return Err(ChatError::ContentPolicy);
        }
        let active: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM chat_turns WHERE owner_id=$1 AND status='RUNNING')",
        )
        .bind(owner)
        .fetch_one(&mut *tx)
        .await?;
        if active {
            return Err(ChatError::Busy);
        }
        let enabled: Option<String> = sqlx::query_scalar(
            "SELECT id FROM models WHERE id=$1 AND kind='chat' AND enabled FOR SHARE",
        )
        .bind(&input.model_id)
        .fetch_optional(&mut *tx)
        .await?;
        if enabled.is_none() {
            return Err(ChatError::Model);
        }
        let maintenance: serde_json::Value =
            sqlx::query_scalar("SELECT value FROM system_settings WHERE key='maintenance_mode'")
                .fetch_one(&mut *tx)
                .await?;
        if maintenance.as_bool() != Some(false) {
            return Err(ChatError::Store);
        }
        let id = Uuid::new_v4();
        let token = Uuid::new_v4();
        sqlx::query("INSERT INTO chat_turns(id,owner_id,conversation_id,request_key,request_hash,model_id,cost,token,intent) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(id).bind(owner).bind(conversation).bind(key).bind(hash).bind(input.model_id).bind(config.credits_per_message).bind(token).bind(serde_json::to_value(intent).map_err(|_|ChatError::Store)?.as_str()).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO chat_messages(conversation_id,turn_id,role,content) VALUES($1,$2,'user',$3),($1,$2,'assistant','')").bind(conversation).bind(id).bind(input.content).execute(&mut *tx).await?;
        if config.credits_per_message > 0 {
            WalletService::apply_in_transaction(
                &mut tx,
                owner,
                Operation::Hold {
                    job: id,
                    amount: config.credits_per_message,
                },
            )
            .await?;
        }
        sqlx::query("UPDATE conversations SET updated_at=clock_timestamp() WHERE id=$1")
            .bind(conversation)
            .execute(&mut *tx)
            .await?;
        audit(&mut tx, owner, "chat.send", conversation).await?;
        tx.commit().await?;
        Ok(Start::Running { turn: id, token })
    }
    pub async fn cancel(&self, owner: Uuid, id: Uuid) -> Result<(), ChatError> {
        let changed =
            sqlx::query("UPDATE chat_turns SET cancel_requested=true WHERE owner_id=$1 AND id=$2 AND status='RUNNING'")
                .bind(owner)
                .bind(id)
                .execute(&self.db)
                .await?;
        if changed.rows_affected() != 1 {
            self.turn(owner, id).await?;
        }
        Ok(())
    }
}
