use crate::WalletError;
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, Payload},
    KeyInit, XChaCha20Poly1305, XNonce,
};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Clone)]
pub struct RedeemCodeCipher(XChaCha20Poly1305);
impl std::fmt::Debug for RedeemCodeCipher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RedeemCodeCipher([REDACTED])")
    }
}
impl RedeemCodeCipher {
    pub fn from_base64(key: &str) -> Result<Self, WalletError> {
        let key = Zeroizing::new(STANDARD.decode(key).map_err(|_| WalletError::Store)?);
        if key.len() != 32 {
            return Err(WalletError::Store);
        }
        let mut hash = Sha256::new();
        hash.update(b"atelier.wallet.redeem-code.v1\0");
        hash.update(&*key);
        let derived = Zeroizing::new(<[u8; 32]>::from(hash.finalize()));
        Ok(Self(
            XChaCha20Poly1305::new_from_slice(&*derived).map_err(|_| WalletError::Store)?,
        ))
    }
    pub(crate) fn seal(&self, id: Uuid, code: &str) -> Result<Vec<u8>, WalletError> {
        let mut nonce = [0u8; 24];
        getrandom::fill(&mut nonce).map_err(|_| WalletError::Store)?;
        let aad = format!("atelier.wallet.redeem-code:{id}:1");
        let encrypted = self
            .0
            .encrypt(
                &XNonce::from(nonce),
                Payload {
                    msg: code.as_bytes(),
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| WalletError::Store)?;
        let mut output = vec![1];
        output.extend(nonce);
        output.extend(encrypted);
        Ok(output)
    }
    pub(crate) fn open(&self, id: Uuid, value: &[u8]) -> Result<Zeroizing<String>, WalletError> {
        if value.len() < 41 || value[0] != 1 {
            return Err(WalletError::Store);
        }
        let aad = format!("atelier.wallet.redeem-code:{id}:1");
        let nonce: [u8; 24] = value[1..25].try_into().map_err(|_| WalletError::Store)?;
        let plain = self
            .0
            .decrypt(
                &XNonce::from(nonce),
                Payload {
                    msg: &value[25..],
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| WalletError::Store)?;
        Ok(Zeroizing::new(
            String::from_utf8(plain).map_err(|_| WalletError::Store)?,
        ))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_is_random_authenticated_and_bound_to_code_and_key() {
        let cipher = RedeemCodeCipher::from_base64(&STANDARD.encode([71; 32])).unwrap();
        let id = Uuid::new_v4();
        let code = "fixture-code-not-a-real-secret";
        let one = cipher.seal(id, code).unwrap();
        let two = cipher.seal(id, code).unwrap();
        assert_ne!(one, two);
        assert!(!one
            .windows(code.len())
            .any(|bytes| bytes == code.as_bytes()));
        assert_eq!(&**cipher.open(id, &one).unwrap(), code);
        assert!(cipher.open(Uuid::new_v4(), &one).is_err());
        assert!(RedeemCodeCipher::from_base64(&STANDARD.encode([72; 32]))
            .unwrap()
            .open(id, &one)
            .is_err());
        let mut damaged = one.clone();
        damaged[30] ^= 1;
        assert!(cipher.open(id, &damaged).is_err());
        assert!(cipher.open(id, &one[..24]).is_err());
        assert!(RedeemCodeCipher::from_base64("bad-key").is_err());
    }
}
