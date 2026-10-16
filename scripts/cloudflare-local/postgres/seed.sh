#!/usr/bin/env sh
set -eu

database="${POSTGRES_DB:-meltiply}"
admin="${POSTGRES_USER:-postgres}"

psql --username "$admin" --dbname "$database" --set ON_ERROR_STOP=1 \
  --file /local/seed.sql
