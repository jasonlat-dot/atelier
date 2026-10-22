use crate::policy::Role;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct SessionUser {
    pub id: Uuid,
    pub email: String,
    pub display_name: String,
    pub role: Role,
    pub mfa_enabled: bool,
}

#[derive(Serialize, ToSchema)]
pub struct MeResponse {
    pub user: SessionUser,
    pub csrf_token: String,
    pub mfa_required: bool,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RenameRequest {
    pub display_name: String,
}

#[derive(Clone, Serialize, ToSchema)]
pub struct DeviceSession {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    pub user_agent: Option<String>,
    pub ip: Option<String>,
    pub current: bool,
}

#[derive(Serialize, ToSchema)]
pub struct DeviceList {
    pub sessions: Vec<DeviceSession>,
}
