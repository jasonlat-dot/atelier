//! Atomic, expiring authentication state. Production never falls back to memory.
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use std::{future::Future, pin::Pin, time::Duration};
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
pub struct TransientError;
pub type TransientFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, TransientError>> + Send + 'a>>;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RateRule {
    pub limit: u32,
    pub window_seconds: u64,
}
pub const LOGIN_RATE: RateRule = RateRule {
    limit: 20,
    window_seconds: 600,
};
pub const GENERATION_RATE: RateRule = RateRule {
    limit: 30,
    window_seconds: 60,
};
pub const CHECKIN_RATE: RateRule = RateRule {
    limit: 10,
    window_seconds: 60,
};
pub const ADMIN_WRITE_RATE: RateRule = RateRule {
    limit: 60,
    window_seconds: 60,
};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RateDecision {
    Allowed,
    Limited { retry_after_seconds: u64 },
}

pub trait TransientStore: Send + Sync {
    fn save_attempt(&self, key: String, value: String, ttl: u64) -> TransientFuture<'_, bool>;
    fn consume_attempt(
        &self,
        key: String,
        browser_hash: String,
    ) -> TransientFuture<'_, Option<String>>;
    fn rate_limit(&self, key: String, rule: RateRule) -> TransientFuture<'_, RateDecision>;
}

pub struct RedisTransient {
    connection: ConnectionManager,
}
impl RedisTransient {
    pub async fn connect(url: &str) -> Result<Self, TransientError> {
        let client = redis::Client::open(url).map_err(|_| TransientError)?;
        let config = ConnectionManagerConfig::new()
            .set_connection_timeout(Some(Duration::from_secs(3)))
            .set_response_timeout(Some(Duration::from_secs(3)));
        let connection = tokio::time::timeout(
            Duration::from_secs(5),
            ConnectionManager::new_with_config(client, config),
        )
        .await
        .map_err(|_| TransientError)?
        .map_err(|_| TransientError)?;
        Ok(Self { connection })
    }
}
const CONSUME: &str = r#"
local value = redis.call('GET', KEYS[1])
if not value then return false end
local record = cjson.decode(value)
if record.browser_hash ~= ARGV[1] then return false end
redis.call('DEL', KEYS[1])
return value
"#;
// TIME is Redis authoritative time; an atomic script prevents concurrent overrun.
const RATE: &str = r#"
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local window = tonumber(ARGV[1]) * 1000
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now-window)
local count = redis.call('ZCARD', KEYS[1])
if count >= tonumber(ARGV[2]) then
    local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
    local retry = math.max(1, math.ceil((tonumber(first[2])+window-now)/1000))
    return {0,retry}
end
redis.call('ZADD', KEYS[1], now, ARGV[3])
redis.call('PEXPIRE', KEYS[1], window)
return {1,0}
"#;
impl TransientStore for RedisTransient {
    fn save_attempt(&self, key: String, value: String, ttl: u64) -> TransientFuture<'_, bool> {
        Box::pin(async move {
            if ttl == 0 || ttl > 600 {
                return Err(TransientError);
            }
            let mut connection = self.connection.clone();
            let result: Option<String> = tokio::time::timeout(
                Duration::from_secs(3),
                redis::cmd("SET")
                    .arg(key)
                    .arg(value)
                    .arg("NX")
                    .arg("EX")
                    .arg(ttl)
                    .query_async(&mut connection),
            )
            .await
            .map_err(|_| TransientError)?
            .map_err(|_| TransientError)?;
            Ok(result.is_some())
        })
    }
    fn consume_attempt(
        &self,
        key: String,
        browser_hash: String,
    ) -> TransientFuture<'_, Option<String>> {
        Box::pin(async move {
            let mut connection = self.connection.clone();
            tokio::time::timeout(
                Duration::from_secs(3),
                redis::Script::new(CONSUME)
                    .key(key)
                    .arg(browser_hash)
                    .invoke_async(&mut connection),
            )
            .await
            .map_err(|_| TransientError)?
            .map_err(|_| TransientError)
        })
    }
    fn rate_limit(&self, key: String, rule: RateRule) -> TransientFuture<'_, RateDecision> {
        Box::pin(async move {
            if rule.limit == 0
                || rule.limit > 10000
                || rule.window_seconds == 0
                || rule.window_seconds > 86400
            {
                return Err(TransientError);
            }
            let mut connection = self.connection.clone();
            let result: Vec<u64> = tokio::time::timeout(
                Duration::from_secs(3),
                redis::Script::new(RATE)
                    .key(key)
                    .arg(rule.window_seconds)
                    .arg(rule.limit)
                    .arg(Uuid::new_v4().to_string())
                    .invoke_async(&mut connection),
            )
            .await
            .map_err(|_| TransientError)?
            .map_err(|_| TransientError)?;
            match result.as_slice() {
                [1, 0] => Ok(RateDecision::Allowed),
                [0, seconds] if *seconds > 0 && *seconds <= rule.window_seconds => {
                    Ok(RateDecision::Limited {
                        retry_after_seconds: *seconds,
                    })
                }
                _ => Err(TransientError),
            }
        })
    }
}
