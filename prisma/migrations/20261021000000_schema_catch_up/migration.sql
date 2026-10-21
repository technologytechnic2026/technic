-- Catch-up for objects that exist in schema.prisma (and prisma/full_schema.sql)
-- but were never captured by a migration. Fully idempotent: a database that
-- already has them (e.g. one created with `prisma db push`) is left unchanged,
-- and a database built from migrations alone gains them. No data is modified.

DO $$ BEGIN
  CREATE TYPE "AccessView" AS ENUM ('COMBINED', 'GST_ONLY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "accessView" "AccessView" NOT NULL DEFAULT 'COMBINED';

ALTER TABLE "quotation_lines" ADD COLUMN IF NOT EXISTS "serialNumbers" TEXT[];

-- goods_receipts.poId is optional (see 20260930170000); the FK must be ON DELETE SET NULL.
ALTER TABLE "goods_receipts" DROP CONSTRAINT IF EXISTS "goods_receipts_poId_fkey";
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_poId_fkey"
  FOREIGN KEY ("poId") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
