-- Keep redemption references and receipts intact when a code is removed.
ALTER TABLE redeem_codes
    ADD COLUMN disabled_at timestamptz,
    ADD COLUMN deleted_at timestamptz,
    ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);

CREATE INDEX redeem_codes_visible_created_idx ON redeem_codes (created_at DESC, id DESC)
    WHERE deleted_at IS NULL;
