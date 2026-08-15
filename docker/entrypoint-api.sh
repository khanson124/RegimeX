#!/bin/sh
set -e

echo "Applying database schema..."
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if pnpm --filter @regimex/database push; then
    break
  fi
  if [ "$i" -eq 12 ]; then
    echo "Database schema apply failed after retries"
    exit 1
  fi
  echo "Database not ready, retrying in 5s..."
  sleep 5
done

if [ "${SEED_ON_START:-true}" = "true" ]; then
  echo "Seeding database..."
  pnpm db:seed || true
fi

exec "$@"
