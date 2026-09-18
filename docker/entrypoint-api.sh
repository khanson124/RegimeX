#!/bin/sh
set -e

# Production schema apply: migrations only (never prisma db push).
# Prisma Client is generated at image build time (pnpm db:generate).
echo "Applying database migrations (prisma migrate deploy)..."
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if pnpm --filter @regimex/database migrate:deploy; then
    echo "Migrations applied"
    break
  fi
  if [ "$i" -eq 12 ]; then
    echo "Database migrate:deploy failed after retries"
    exit 1
  fi
  echo "Database not ready for migrate:deploy, retrying in 5s..."
  sleep 5
done

if [ "${SEED_ON_START:-true}" = "true" ]; then
  echo "Seeding database..."
  pnpm db:seed || true
fi

exec "$@"
