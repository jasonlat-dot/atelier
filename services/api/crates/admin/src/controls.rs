use crate::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
fn validate_rule(v: &AdminRuleInput) -> Result<(), AdminError> {
    reason(&v.reason)?;
    if v.pattern.trim().is_empty() || v.pattern.chars().count() > 512 || v.pattern.contains('\0') {
        return Err(AdminError::Validation);
    }
    if v.is_regex {
        regex::RegexBuilder::new(&v.pattern)
            .size_limit(1048576)
            .dfa_size_limit(1048576)
            .build()
            .map_err(|_| AdminError::Validation)?;
    }
    Ok(())
}
fn validate_invite(v: &AdminInviteInput) -> Result<(), AdminError> {
    reason(&v.reason)?;
    if v.label.trim().is_empty()
        || v.label.chars().any(char::is_control)
        || v.label.chars().count() > 80
        || !(1..=10000).contains(&v.max_uses)
        || v.expires_at.is_some_and(|d| d <= chrono::Utc::now())
    {
        return Err(AdminError::Validation);
    }
    Ok(())
}
impl AdminService {
    pub async fn rules(&self, q: &str, before: Option<i64>) -> Result<AdminRulePage, AdminError> {
        search(q)?;
        if before.is_some_and(|v| v <= 0) {
            return Err(AdminError::Validation);
        }
        let mut items:Vec<AdminRule>=sqlx::query_as("SELECT id,pattern,is_regex,enabled,revision FROM moderation_rules WHERE deleted_at IS NULL AND strpos(lower(pattern),lower($1))>0 AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT 26").bind(q).bind(before).fetch_all(&self.db).await?;
        let more = items.len() > 25;
        items.truncate(25);
        let next_cursor = if more {
            items.last().map(|r| r.id)
        } else {
            None
        };
        Ok(AdminRulePage { items, next_cursor })
    }
    pub async fn save_rule(
        &self,
        who: Uuid,
        id: Option<i64>,
        v: &AdminRuleInput,
    ) -> Result<AdminRule, AdminError> {
        validate_rule(v)?;
        let mut tx = self.db.begin().await?;
        identity_lock(&mut tx).await?;
        actor(&mut tx, who, false).await?;
        let old: Option<AdminRule> = if let Some(id) = id {
            Some(sqlx::query_as("SELECT id,pattern,is_regex,enabled,revision FROM moderation_rules WHERE id=$1 AND deleted_at IS NULL FOR UPDATE").bind(id).fetch_optional(&mut *tx).await?.ok_or(AdminError::NotFound)?)
        } else {
            None
        };
        if let Some(o) = &old {
            if Some(o.revision) != v.revision {
                return Err(AdminError::Conflict);
            }
        } else {
            if v.revision.is_some() {
                return Err(AdminError::Validation);
            }
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM moderation_rules WHERE deleted_at IS NULL",
            )
            .fetch_one(&mut *tx)
            .await?;
            if count >= 1000 {
                return Err(AdminError::Conflict);
            }
        }
        let view: AdminRule = if let Some(id) = id {
            sqlx::query_as("UPDATE moderation_rules SET pattern=$2,is_regex=$3,enabled=$4,revision=revision+1 WHERE id=$1 RETURNING id,pattern,is_regex,enabled,revision").bind(id).bind(&v.pattern).bind(v.is_regex).bind(v.enabled).fetch_one(&mut *tx).await?
        } else {
            sqlx::query_as("INSERT INTO moderation_rules(pattern,is_regex,enabled) VALUES($1,$2,$3) RETURNING id,pattern,is_regex,enabled,revision").bind(&v.pattern).bind(v.is_regex).bind(v.enabled).fetch_one(&mut *tx).await?
        };
        audit(
            &mut tx,
            who,
            if old.is_some() {
                "ADMIN_RULE_UPDATED"
            } else {
                "ADMIN_RULE_CREATED"
            },
            "moderation_rule",
            &view.id.to_string(),
            json!(old),
            json!(view),
            &v.reason,
        )
        .await?;
        tx.commit().await?;
        Ok(view)
    }
    pub async fn delete_rule(
        &self,
        who: Uuid,
        id: i64,
        v: &AdminRevisionReason,
    ) -> Result<(), AdminError> {
        reason(&v.reason)?;
        let mut tx = self.db.begin().await?;
        identity_lock(&mut tx).await?;
        actor(&mut tx, who, false).await?;
        let old:AdminRule=sqlx::query_as("SELECT id,pattern,is_regex,enabled,revision FROM moderation_rules WHERE id=$1 AND deleted_at IS NULL FOR UPDATE").bind(id).fetch_optional(&mut *tx).await?.ok_or(AdminError::NotFound)?;
        if old.revision != v.revision {
            return Err(AdminError::Conflict);
        }
        sqlx::query("UPDATE moderation_rules SET enabled=false,deleted_at=clock_timestamp(),revision=revision+1 WHERE id=$1").bind(id).execute(&mut *tx).await?;
        audit(
            &mut tx,
            who,
            "ADMIN_RULE_DELETED",
            "moderation_rule",
            &id.to_string(),
            json!(old),
            Value::Null,
            &v.reason,
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn invites(
        &self,
        q: &str,
        before: Option<Uuid>,
    ) -> Result<AdminInvitePage, AdminError> {
        search(q)?;
        let mut items:Vec<AdminInvite>=sqlx::query_as("SELECT id,label,last4,max_uses,used_count,expires_at,created_at,revoked_at,revision FROM invite_codes WHERE strpos(lower(label||' '||coalesce(last4,'')),lower($1))>0 AND ($2::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM invite_codes WHERE id=$2)) ORDER BY created_at DESC,id DESC LIMIT 26").bind(q).bind(before).fetch_all(&self.db).await?;
        let more = items.len() > 25;
        items.truncate(25);
        let next_cursor = if more {
            items.last().map(|r| r.id)
        } else {
            None
        };
        Ok(AdminInvitePage { items, next_cursor })
    }
    pub async fn create_invite(
        &self,
        who: Uuid,
        v: &AdminInviteInput,
    ) -> Result<AdminInviteCreated, AdminError> {
        validate_invite(v)?;
        let mut tx = self.db.begin().await?;
        identity_lock(&mut tx).await?;
        actor(&mut tx, who, false).await?;
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| AdminError::Store)?;
        let code = format!("ati_{}", URL_SAFE_NO_PAD.encode(bytes));
        let last4 = &code[code.len() - 4..];
        let view:AdminInvite=sqlx::query_as("INSERT INTO invite_codes(code_hash,label,last4,max_uses,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,label,last4,max_uses,used_count,expires_at,created_at,revoked_at,revision").bind(Sha256::digest(code.as_bytes()).as_slice()).bind(v.label.trim()).bind(last4).bind(v.max_uses).bind(v.expires_at).bind(who).fetch_one(&mut *tx).await?;
        audit(
            &mut tx,
            who,
            "ADMIN_INVITE_CREATED",
            "invite_code",
            &view.id.to_string(),
            Value::Null,
            json!(view),
            &v.reason,
        )
        .await?;
        tx.commit().await?;
        Ok(AdminInviteCreated { invite: view, code })
    }
    pub async fn update_invite(
        &self,
        who: Uuid,
        id: Uuid,
        v: &AdminInviteUpdate,
    ) -> Result<AdminInvite, AdminError> {
        validate_invite(&v.details)?;
        let mut tx = self.db.begin().await?;
        identity_lock(&mut tx).await?;
        actor(&mut tx, who, false).await?;
        let old = invite(&mut tx, id).await?;
        if old.revision != v.revision || old.revoked_at.is_some() {
            return Err(AdminError::Conflict);
        }
        if v.details.max_uses < old.used_count {
            return Err(AdminError::Validation);
        }
        let view=sqlx::query_as("UPDATE invite_codes SET label=$2,max_uses=$3,expires_at=$4,revision=revision+1 WHERE id=$1 RETURNING id,label,last4,max_uses,used_count,expires_at,created_at,revoked_at,revision").bind(id).bind(v.details.label.trim()).bind(v.details.max_uses).bind(v.details.expires_at).fetch_one(&mut *tx).await?;
        audit(
            &mut tx,
            who,
            "ADMIN_INVITE_UPDATED",
            "invite_code",
            &id.to_string(),
            json!(old),
            json!(view),
            &v.details.reason,
        )
        .await?;
        tx.commit().await?;
        Ok(view)
    }
    pub async fn revoke_invite(
        &self,
        who: Uuid,
        id: Uuid,
        v: &AdminRevisionReason,
    ) -> Result<AdminInvite, AdminError> {
        reason(&v.reason)?;
        let mut tx = self.db.begin().await?;
        identity_lock(&mut tx).await?;
        actor(&mut tx, who, false).await?;
        let old = invite(&mut tx, id).await?;
        if old.revision != v.revision {
            return Err(AdminError::Conflict);
        }
        let view=sqlx::query_as("UPDATE invite_codes SET revoked_at=coalesce(revoked_at,clock_timestamp()),revision=revision+1 WHERE id=$1 RETURNING id,label,last4,max_uses,used_count,expires_at,created_at,revoked_at,revision").bind(id).fetch_one(&mut *tx).await?;
        audit(
            &mut tx,
            who,
            "ADMIN_INVITE_REVOKED",
            "invite_code",
            &id.to_string(),
            json!(old),
            json!(view),
            &v.reason,
        )
        .await?;
        tx.commit().await?;
        Ok(view)
    }
}
async fn invite(db: &mut PgConnection, id: Uuid) -> Result<AdminInvite, AdminError> {
    sqlx::query_as("SELECT id,label,last4,max_uses,used_count,expires_at,created_at,revoked_at,revision FROM invite_codes WHERE id=$1 FOR UPDATE").bind(id).fetch_optional(db).await?.ok_or(AdminError::NotFound)
}
