use crate::AssetError;
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ring::hmac;
use uuid::Uuid;
#[derive(Clone)]
pub struct MediaSigner {
    key: hmac::Key,
}
impl MediaSigner {
    pub fn from_base64(master: &str) -> Result<Self, AssetError> {
        let raw = STANDARD.decode(master).map_err(|_| AssetError::Store)?;
        if raw.len() != 32 {
            return Err(AssetError::Store);
        }
        let master = hmac::Key::new(hmac::HMAC_SHA256, &raw);
        let derived = hmac::sign(&master, b"atelier/media-signing/v1");
        Ok(Self {
            key: hmac::Key::new(hmac::HMAC_SHA256, derived.as_ref()),
        })
    }
    fn message(owner: Uuid, id: Uuid, variant: &str, expires: i64) -> String {
        format!("v1\n{owner}\n{id}\n{variant}\n{expires}")
    }
    pub fn url(&self, owner: Uuid, id: Uuid, variant: &str, expires: i64) -> String {
        let signature = hmac::sign(
            &self.key,
            Self::message(owner, id, variant, expires).as_bytes(),
        );
        format!(
            "/media/{id}/{variant}?expires={expires}&signature={}",
            URL_SAFE_NO_PAD.encode(signature.as_ref())
        )
    }
    pub fn verify(
        &self,
        owner: Uuid,
        id: Uuid,
        variant: &str,
        expires: i64,
        signature: &str,
        now: i64,
    ) -> Result<(), AssetError> {
        if !matches!(variant, "original" | "thumbnail") || expires <= now || expires > now + 300 {
            return Err(AssetError::NotFound);
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| AssetError::NotFound)?;
        hmac::verify(
            &self.key,
            Self::message(owner, id, variant, expires).as_bytes(),
            &bytes,
        )
        .map_err(|_| AssetError::NotFound)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signatures_expire_and_bind_owner_asset_and_variant() {
        let signer = MediaSigner::from_base64(&STANDARD.encode([7u8; 32])).unwrap();
        let owner = Uuid::new_v4();
        let id = Uuid::new_v4();
        let url = signer.url(owner, id, "original", 1200);
        let sig = url.split("signature=").nth(1).unwrap();
        assert!(signer
            .verify(owner, id, "original", 1200, sig, 1000)
            .is_ok());
        for (owner, id, variant, expires, now) in [
            (Uuid::new_v4(), id, "original", 1200, 1000),
            (owner, Uuid::new_v4(), "original", 1200, 1000),
            (owner, id, "thumbnail", 1200, 1000),
            (owner, id, "original", 1199, 1000),
            (owner, id, "original", 1200, 1200),
        ] {
            assert!(signer
                .verify(owner, id, variant, expires, sig, now)
                .is_err());
        }
    }
}
