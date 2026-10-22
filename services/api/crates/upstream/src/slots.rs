//! Atomic shared concurrency slots, with token fencing and authoritative Redis time.
use crate::Error;
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use std::time::Duration;
use uuid::Uuid;
const CLAIM: &str = r#"
local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now)
if redis.call('ZSCORE',KEYS[1],ARGV[1]) or redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[2]) then return 0 end
redis.call('ZADD',KEYS[1],now+tonumber(ARGV[3])*1000,ARGV[1])
local ttl=(tonumber(ARGV[3])+1)*1000;if redis.call('PTTL',KEYS[1])<ttl then redis.call('PEXPIRE',KEYS[1],ttl) end;return 1
"#;
const RENEW: &str = r#"
local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now)
if not redis.call('ZSCORE',KEYS[1],ARGV[1]) then return 0 end
redis.call('ZADD',KEYS[1],now+tonumber(ARGV[2])*1000,ARGV[1])
local ttl=(tonumber(ARGV[2])+1)*1000;if redis.call('PTTL',KEYS[1])<ttl then redis.call('PEXPIRE',KEYS[1],ttl) end;return 1
"#;
const COUNT: &str = r#"
local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now);return redis.call('ZCARD',KEYS[1])
"#;
#[derive(Clone)]
pub struct SlotStore {
    connection: ConnectionManager,
    prefix: String,
}
impl SlotStore {
    pub async fn connect(url: &str, prefix: &str) -> Result<Self, Error> {
        if prefix.is_empty()
            || prefix.len() > 100
            || !prefix
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_:".contains(&b))
        {
            return Err(Error::Validation);
        }
        let config = ConnectionManagerConfig::new()
            .set_connection_timeout(Some(Duration::from_secs(3)))
            .set_response_timeout(Some(Duration::from_secs(3)));
        let client = redis::Client::open(url).map_err(|_| Error::Store)?;
        let connection = tokio::time::timeout(
            Duration::from_secs(5),
            ConnectionManager::new_with_config(client, config),
        )
        .await
        .map_err(|_| Error::Store)?
        .map_err(|_| Error::Store)?;
        Ok(Self {
            connection,
            prefix: prefix.into(),
        })
    }
    fn key(&self, id: Uuid) -> String {
        format!("{}:{{{id}}}:slots", self.prefix)
    }
    pub async fn claim(&self, id: Uuid, token: &str, limit: i32, ttl: u64) -> Result<bool, Error> {
        if !(1..=64).contains(&limit) || !(1..=300).contains(&ttl) || token.len() > 100 {
            return Err(Error::Validation);
        }
        let value: i64 = tokio::time::timeout(
            Duration::from_secs(3),
            redis::Script::new(CLAIM)
                .key(self.key(id))
                .arg(token)
                .arg(limit)
                .arg(ttl)
                .invoke_async(&mut self.connection.clone()),
        )
        .await
        .map_err(|_| Error::Store)?
        .map_err(|_| Error::Store)?;
        Ok(value == 1)
    }
    pub async fn renew(&self, id: Uuid, token: &str, ttl: u64) -> Result<bool, Error> {
        if !(1..=300).contains(&ttl) {
            return Err(Error::Validation);
        }
        let value: i64 = tokio::time::timeout(
            Duration::from_secs(3),
            redis::Script::new(RENEW)
                .key(self.key(id))
                .arg(token)
                .arg(ttl)
                .invoke_async(&mut self.connection.clone()),
        )
        .await
        .map_err(|_| Error::Store)?
        .map_err(|_| Error::Store)?;
        Ok(value == 1)
    }
    pub async fn release(&self, id: Uuid, token: &str) -> Result<(), Error> {
        let _: i64 = tokio::time::timeout(
            Duration::from_secs(3),
            redis::cmd("ZREM")
                .arg(self.key(id))
                .arg(token)
                .query_async(&mut self.connection.clone()),
        )
        .await
        .map_err(|_| Error::Store)?
        .map_err(|_| Error::Store)?;
        Ok(())
    }
    pub async fn counts(&self, ids: &[Uuid]) -> Result<Vec<i64>, Error> {
        if ids.len() > 500 {
            return Err(Error::Validation);
        }
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let mut pipe = redis::pipe();
        for id in ids {
            pipe.cmd("EVAL").arg(COUNT).arg(1).arg(self.key(*id));
        }
        tokio::time::timeout(
            Duration::from_secs(3),
            pipe.query_async(&mut self.connection.clone()),
        )
        .await
        .map_err(|_| Error::Store)?
        .map_err(|_| Error::Store)
    }
}
