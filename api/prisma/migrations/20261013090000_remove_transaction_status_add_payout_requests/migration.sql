-- Remove transaction status; a tester asking to be paid becomes a PayoutRequest.
--
-- The TYPE of a ledger row now says everything status used to: TESTER_EARNING
-- is a credit, TESTER_PAYOUT is a debit that has already been paid. A payout
-- that was still PENDING had not moved any money, so it cannot stay a ledger
-- row (it would silently turn into a debit the moment its status vanished).
-- Those rows become open payout requests instead.
--
-- This file runs as one multi-statement query, i.e. one implicit transaction:
-- either every step applies or none does.

-- 1. The new table.
CREATE TABLE "payout_requests" (
    "id" TEXT NOT NULL,
    "tester_id" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "payment_account_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fulfilled_at" TIMESTAMP(3),
    "fulfilled_by_transaction_id" TEXT,

    CONSTRAINT "payout_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payout_requests_fulfilled_by_transaction_id_key" ON "payout_requests"("fulfilled_by_transaction_id");
CREATE INDEX "payout_requests_tester_id_fulfilled_at_idx" ON "payout_requests"("tester_id", "fulfilled_at");

ALTER TABLE "payout_requests" ADD CONSTRAINT "payout_requests_tester_id_fkey" FOREIGN KEY ("tester_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payout_requests" ADD CONSTRAINT "payout_requests_payment_account_id_fkey" FOREIGN KEY ("payment_account_id") REFERENCES "payment_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payout_requests" ADD CONSTRAINT "payout_requests_fulfilled_by_transaction_id_fkey" FOREIGN KEY ("fulfilled_by_transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. Unpaid payouts -> open requests, then out of the ledger. The row id is
--    reused so anything that referenced it (an audit entry, a notification)
--    still points at something. Method, TDS and bank reference on an unpaid
--    payout described an intention, and are entered again when it is paid.
INSERT INTO "payout_requests" ("id", "tester_id", "amount_minor", "currency", "payment_account_id", "note", "created_at")
SELECT "id", "counterparty_id", "amount_minor", "currency", "payment_account_id", "description", "created_at"
FROM "transactions"
WHERE "type" = 'TESTER_PAYOUT' AND "status" = 'PENDING' AND "counterparty_id" IS NOT NULL;

DELETE FROM "transactions"
WHERE "type" = 'TESTER_PAYOUT' AND "status" = 'PENDING' AND "counterparty_id" IS NOT NULL;

-- 3. Status goes. `settled_at` goes with it: it only ever recorded when a row
--    was marked paid, and equals `occurred_at` for every migrated row.
DROP INDEX "transactions_type_status_idx";
ALTER TABLE "transactions" DROP COLUMN "status", DROP COLUMN "settled_at";
DROP TYPE "TransactionStatus";
CREATE INDEX "transactions_type_idx" ON "transactions"("type");
