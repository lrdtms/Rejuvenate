-- NOTE: `prisma migrate diff` (run against the live dev DB to generate this
-- script) proposed `DROP TABLE "session"` here. That table is INTENTIONALLY
-- absent from schema.prisma — it is owned end-to-end by `connect-pg-simple`
-- outside Prisma's migration history (see the long decision-record comment at
-- the top of schema.prisma, "SESSION STORE — DECISION RECORD"). Diffing
-- against a live database that connect-pg-simple has already created the
-- table in necessarily produces this false-positive "drop" — applying it
-- would destroy every active session (logging out all staff) and the table
-- would simply be re-created on the next request by `createTableIfMissing:
-- true`. Removed by hand; do not re-add it.

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key" ON "password_reset_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_userId_idx" ON "password_reset_tokens"("userId");

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

