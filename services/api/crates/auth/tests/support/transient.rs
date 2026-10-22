use atelier_auth::transient::{RateDecision, RateRule, TransientFuture, TransientStore};
use std::{collections::HashMap, sync::Mutex};
#[derive(Default)]
pub struct MemoryTransient {
    values: Mutex<HashMap<String, String>>,
    counts: Mutex<HashMap<String, u32>>,
}
impl TransientStore for MemoryTransient {
    fn save_attempt(&self, key: String, value: String, _ttl: u64) -> TransientFuture<'_, bool> {
        Box::pin(async move {
            let mut values = self.values.lock().unwrap();
            if values.contains_key(&key) {
                return Ok(false);
            }
            values.insert(key, value);
            Ok(true)
        })
    }
    fn consume_attempt(
        &self,
        key: String,
        browser_hash: String,
    ) -> TransientFuture<'_, Option<String>> {
        Box::pin(async move {
            let mut values = self.values.lock().unwrap();
            if !values.get(&key).is_some_and(|v| {
                serde_json::from_str::<serde_json::Value>(v).unwrap()["browser_hash"]
                    == browser_hash
            }) {
                return Ok(None);
            }
            Ok(values.remove(&key))
        })
    }
    fn rate_limit(&self, key: String, rule: RateRule) -> TransientFuture<'_, RateDecision> {
        Box::pin(async move {
            let mut counts = self.counts.lock().unwrap();
            let n = counts.entry(key).or_default();
            *n += 1;
            Ok(if *n <= rule.limit {
                RateDecision::Allowed
            } else {
                RateDecision::Limited {
                    retry_after_seconds: rule.window_seconds,
                }
            })
        })
    }
}
