//! Resolve once, reject every unsafe answer, and pin approved HTTP(S) addresses.
use crate::{Error, ProviderFailure};
use bytes::Bytes;
use reqwest::{header, Method};
use std::{
    collections::HashSet,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Semaphore;
use url::{Host, Url};

#[derive(Clone, Default)]
pub struct EgressPolicy {
    local_origins: HashSet<String>,
    endpoint_origins: HashSet<String>,
}
impl EgressPolicy {
    /// Administrators choose account endpoints. Their HTTP(S) origins are not
    /// filtered by IP range; unrelated provider-returned download URLs do not
    /// inherit this permission.
    pub fn for_endpoint(&self, value: &str) -> Result<Self, Error> {
        let url = Url::parse(value).map_err(|_| Error::UnsafeUrl)?;
        let mut policy = self.clone();
        policy
            .endpoint_origins
            .insert(url.origin().ascii_serialization());
        policy.parse(value, false)?;
        Ok(policy)
    }
    pub fn with_local_origins(origins: Vec<String>) -> Result<Self, Error> {
        if origins.len() > 16 {
            return Err(Error::Validation);
        }
        let mut local_origins = HashSet::new();
        for origin in origins {
            let url = Url::parse(&origin).map_err(|_| Error::UnsafeUrl)?;
            let loopback = match url.host() {
                Some(Host::Ipv4(ip)) => ip.is_loopback(),
                Some(Host::Ipv6(ip)) => ip.is_loopback(),
                _ => false,
            };
            if !loopback
                || !matches!(url.scheme(), "http" | "https")
                || url.path() != "/"
                || url.query().is_some()
                || url.fragment().is_some()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err(Error::UnsafeUrl);
            }
            local_origins.insert(url.origin().ascii_serialization());
        }
        Ok(Self {
            local_origins,
            endpoint_origins: HashSet::new(),
        })
    }
    pub fn parse(&self, value: &str, allow_query: bool) -> Result<Url, Error> {
        if value.len() > 2048 || value.bytes().any(|b| b <= 32 || b == 127 || b == b'\\') {
            return Err(Error::UnsafeUrl);
        }
        let url = Url::parse(value).map_err(|_| Error::UnsafeUrl)?;
        let local = self
            .local_origins
            .contains(&url.origin().ascii_serialization());
        let endpoint = self
            .endpoint_origins
            .contains(&url.origin().ascii_serialization());
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || (!allow_query && url.query().is_some())
            || url.host().is_none()
        {
            return Err(Error::UnsafeUrl);
        }
        match url.host() {
            Some(Host::Ipv4(ip)) if !public_ip(IpAddr::V4(ip)) && !local && !endpoint => {
                return Err(Error::UnsafeUrl)
            }
            Some(Host::Ipv6(ip)) if !public_ip(IpAddr::V6(ip)) && !local && !endpoint => {
                return Err(Error::UnsafeUrl)
            }
            Some(Host::Domain(name))
                if !endpoint
                    && (name == "localhost"
                        || name.ends_with(".localhost")
                        || name.ends_with(".local")) =>
            {
                return Err(Error::UnsafeUrl)
            }
            _ => {}
        }
        Ok(url)
    }
    pub async fn validate(&self, value: &str) -> Result<Url, Error> {
        let url = self.parse(value, false)?;
        self.addresses(&url).await?;
        Ok(url)
    }
    async fn addresses(&self, url: &Url) -> Result<Vec<SocketAddr>, Error> {
        let port = url.port_or_known_default().ok_or(Error::UnsafeUrl)?;
        let addresses: Vec<_> = match url.host().ok_or(Error::UnsafeUrl)? {
            Host::Ipv4(ip) => vec![SocketAddr::new(ip.into(), port)],
            Host::Ipv6(ip) => vec![SocketAddr::new(ip.into(), port)],
            Host::Domain(name) => tokio::time::timeout(
                Duration::from_secs(3),
                tokio::net::lookup_host((name, port)),
            )
            .await
            .map_err(|_| Error::Store)?
            .map_err(|_| Error::Store)?
            .collect(),
        };
        let local = self
            .local_origins
            .contains(&url.origin().ascii_serialization());
        let endpoint = self
            .endpoint_origins
            .contains(&url.origin().ascii_serialization());
        if addresses.is_empty()
            || addresses.len() > 64
            || addresses.iter().any(|addr| {
                if endpoint {
                    false
                } else if local {
                    !addr.ip().is_loopback()
                } else {
                    !public_ip(addr.ip())
                }
            })
        {
            return Err(Error::UnsafeUrl);
        }
        Ok(addresses)
    }
}
fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ip.is_unspecified()
        || a == 0
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0 && (c == 0 || c == 2))
        || (a == 192 && b == 88 && c == 99)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113))
}
fn public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return public_v4(v4);
    }
    let s = ip.segments();
    (s[0] & 0xe000) == 0x2000
        && s[0] != 0x2002
        && !(s[0] == 0x2001
            && (s[1] == 0
                || s[1] == 2
                || s[1] == 0xdb8
                || (s[1] & 0xfff0) == 0x10
                || (s[1] & 0xfff0) == 0x20))
}
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip),
        IpAddr::V6(ip) => public_v6(ip),
    }
}
pub enum Payload {
    Empty,
    Json(serde_json::Value),
    Multipart(reqwest::multipart::Form),
}
pub struct Response {
    pub status: u16,
    pub retry_after: Option<u64>,
    pub content_type: String,
    pub body: Bytes,
}
#[derive(Clone)]
pub struct SafeHttp {
    pub policy: EgressPolicy,
    slots: Arc<Semaphore>,
    max_duration: Duration,
}
impl SafeHttp {
    pub fn for_endpoint(&self, value: &str) -> Result<Self, Error> {
        Ok(Self {
            policy: self.policy.for_endpoint(value)?,
            ..self.clone()
        })
    }
    pub fn new(policy: EgressPolicy) -> Self {
        // reqwest's no-provider feature deliberately requires explicit setup.
        // install_default is process-once and harmless if another component won.
        let _ = rustls::crypto::ring::default_provider().install_default();
        Self {
            policy,
            slots: Arc::new(Semaphore::new(8)),
            max_duration: Duration::from_secs(310),
        }
    }
    pub fn with_timeout_limit(mut self, limit: Duration) -> Self {
        self.max_duration = limit.min(self.max_duration).max(Duration::from_millis(1));
        self
    }
    pub async fn open_stream(
        &self,
        method: Method,
        url: &str,
        secret: Option<&str>,
        payload: Payload,
        timeout: Duration,
        max_bytes: usize,
    ) -> Result<GuardedResponse, Error> {
        if max_bytes > 256 * 1024 * 1024 {
            return Err(Error::Validation);
        }
        let slot = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::NoCapacity)?;
        let response = tokio::time::timeout(timeout.min(self.max_duration), async {
            let url = self.policy.parse(url, true)?;
            let addrs = self.policy.addresses(&url).await?;
            let mut builder = reqwest::Client::builder()
                .no_proxy()
                .retry(reqwest::retry::never())
                .redirect(reqwest::redirect::Policy::none())
                .referer(false)
                .connect_timeout(Duration::from_secs(5))
                .timeout(timeout.min(self.max_duration))
                .pool_max_idle_per_host(0);
            if let Some(Host::Domain(host)) = url.host() {
                builder = builder.resolve_to_addrs(host, &addrs);
            }
            let client = builder.build().map_err(|_| Error::Store)?;
            let mut request = client.request(method, url);
            if let Some(secret) = secret {
                let mut value = header::HeaderValue::from_str(&format!("Bearer {secret}"))
                    .map_err(|_| Error::Validation)?;
                value.set_sensitive(true);
                request = request.header(header::AUTHORIZATION, value);
            }
            request = match payload {
                Payload::Empty => request,
                Payload::Json(value) => request.json(&value),
                Payload::Multipart(form) => request.multipart(form),
            };
            let response = request
                .send()
                .await
                .map_err(|_| Error::Provider(ProviderFailure::network()))?;
            if response.status().is_redirection() {
                return Err(Error::Provider(ProviderFailure::network()));
            }
            if response
                .content_length()
                .is_some_and(|n| n > max_bytes as u64)
            {
                return Err(Error::Provider(ProviderFailure::network()));
            }

            Ok::<_, Error>(response)
        })
        .await
        .map_err(|_| Error::Provider(ProviderFailure::network()))??;
        Ok(GuardedResponse {
            response,
            _slot: slot,
            total: 0,
            max_bytes,
        })
    }
    pub async fn send(
        &self,
        method: Method,
        url: &str,
        secret: Option<&str>,
        payload: Payload,
        timeout: Duration,
        max_bytes: usize,
    ) -> Result<Response, Error> {
        let mut stream = self
            .open_stream(method, url, secret, payload, timeout, max_bytes)
            .await?;
        let status = stream.response.status().as_u16();
        let retry_after = retry_after(&stream.response);
        let content_type = stream.content_type();
        let mut body = Vec::new();
        while let Some(chunk) = stream.chunk().await? {
            body.extend_from_slice(&chunk);
        }
        Ok(Response {
            status,
            retry_after,
            content_type,
            body: body.into(),
        })
    }
}

pub struct GuardedResponse {
    response: reqwest::Response,
    _slot: tokio::sync::OwnedSemaphorePermit,
    total: usize,
    max_bytes: usize,
}
impl GuardedResponse {
    pub fn status(&self) -> u16 {
        self.response.status().as_u16()
    }
    pub fn retry_after(&self) -> Option<u64> {
        retry_after(&self.response)
    }
    pub fn content_type(&self) -> String {
        self.response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .to_owned()
    }
    pub async fn chunk(&mut self) -> Result<Option<Bytes>, Error> {
        let chunk = self
            .response
            .chunk()
            .await
            .map_err(|_| Error::Provider(ProviderFailure::network()))?;
        if let Some(chunk) = &chunk {
            self.total = self
                .total
                .checked_add(chunk.len())
                .ok_or(Error::Validation)?;
            if self.total > self.max_bytes {
                return Err(Error::Provider(ProviderFailure::network()));
            }
        }
        Ok(chunk)
    }
}
fn retry_after(response: &reqwest::Response) -> Option<u64> {
    response
        .headers()
        .get(header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.parse::<u64>().ok().or_else(|| {
                chrono::DateTime::parse_from_rfc2822(v)
                    .ok()
                    .map(|d| (d.timestamp() - chrono::Utc::now().timestamp()).max(1) as u64)
            })
        })
        .map(|n| n.clamp(1, 86400))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_private_special_encoded_and_credential_addresses() {
        let policy = EgressPolicy::default();
        for address in [
            "https://127.1",
            "https://2130706433",
            "https://0x7f000001",
            "https://169.254.169.254/latest/meta-data",
            "https://10.2.3.4",
            "https://100.64.0.1",
            "https://192.0.2.1",
            "https://[::1]",
            "https://[::ffff:127.0.0.1]",
            "https://[2001:db8::1]",
            "https://user:pass@example.com",
            "https://example.com/#fragment",
            "https://localhost/v1",
            "https://foo.local/v1",
        ] {
            assert!(policy.parse(address, false).is_err(), "{address}");
        }
        assert!(policy.parse("https://8.8.8.8/v1", false).is_ok());
        assert!(policy.parse("https://example.com/v1", false).is_ok());
        let local =
            EgressPolicy::with_local_origins(vec!["http://127.0.0.1:19999".into()]).unwrap();
        assert!(local.parse("http://127.0.0.1:19999/v1", false).is_ok());
        assert!(local.parse("http://127.0.0.1:19998/v1", false).is_err());
        assert!(EgressPolicy::with_local_origins(vec!["http://10.0.0.1".into()]).is_err());
    }

    #[test]
    fn permits_public_http_and_https_but_keeps_address_and_scheme_checks() {
        let policy = EgressPolicy::default();
        for scheme in ["http", "https"] {
            for host in ["8.8.8.8", "example.com", "example.com:8080"] {
                assert!(policy
                    .parse(&format!("{scheme}://{host}/v1"), false)
                    .is_ok());
            }
            for host in [
                "127.1",
                "2130706433",
                "0x7f000001",
                "10.0.0.1",
                "169.254.169.254",
                "[::1]",
                "[::ffff:127.0.0.1]",
                "localhost",
                "foo.local",
                "user:pass@example.com",
            ] {
                assert!(policy
                    .parse(&format!("{scheme}://{host}/v1"), false)
                    .is_err());
            }
            assert!(policy
                .parse(&format!("{scheme}://example.com/v1?token=value"), false)
                .is_err());
            assert!(policy
                .parse(&format!("{scheme}://example.com/v1#fragment"), false)
                .is_err());
        }
        for scheme in ["ftp", "file", "gopher", "ws", "wss"] {
            assert!(policy
                .parse(&format!("{scheme}://example.com/v1"), false)
                .is_err());
        }
    }

    #[test]
    fn administrator_endpoint_has_no_ip_range_filter_and_needs_no_allowlist() {
        let policy = EgressPolicy::default();
        for scheme in ["http", "https"] {
            for host in [
                "localhost:3000",
                "127.0.0.1:3000",
                "[::1]:3000",
                "10.0.0.1:8080",
                "192.168.1.8",
                "172.20.0.8",
                "100.64.0.1",
                "169.254.169.254",
                "0.0.0.0:3000",
                "[fd00::1]",
                "upstream.local",
                "not-resolved.invalid",
                "8.8.8.8",
            ] {
                let value = format!("{scheme}://{host}/v1");
                let endpoint = policy.for_endpoint(&value).unwrap();
                assert!(endpoint.parse(&value, false).is_ok(), "{value}");
            }
        }
        let endpoint = policy.for_endpoint("http://localhost:3000/v1").unwrap();
        assert!(endpoint
            .parse(
                "http://localhost:3000/images/result.png?signature=abc",
                true
            )
            .is_ok());
        // A provider-returned URL cannot authorize unrelated local services.
        assert!(endpoint
            .parse("http://127.0.0.1:9000/private", true)
            .is_err());
        assert!(policy.for_endpoint("file:///etc/passwd").is_err());
        assert!(policy.for_endpoint("ftp://localhost/file").is_err());
        assert!(policy.for_endpoint("http://localhost:99999/v1").is_err());
        assert!(policy
            .for_endpoint("http://localhost:3000/v1?key=value")
            .is_err());
    }
}
