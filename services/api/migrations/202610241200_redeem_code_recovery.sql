-- Hashes remain the redemption lookup. Existing hash-only codes cannot be recovered.
ALTER TABLE redeem_codes ADD COLUMN code_enc bytea;
ALTER TABLE redeem_codes ADD CONSTRAINT redeem_code_envelope CHECK
    (code_enc IS NULL OR (octet_length(code_enc) >= 41 AND get_byte(code_enc, 0) = 1));
CREATE INDEX redeem_codes_created_page ON redeem_codes(created_at DESC, id DESC);
