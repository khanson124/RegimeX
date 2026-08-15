#!/bin/sh
set -e

echo "Waiting for database schema..."
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18; do
  if pnpm --filter @regimex/database push; then
    echo "Schema ready"
    break
  fi
  if [ "$i" -eq 18 ]; then
    echo "Database schema not available after retries"
    exit 1
  fi
  echo "Schema not ready, retrying in 5s..."
  sleep 5
done

exec "$@"
