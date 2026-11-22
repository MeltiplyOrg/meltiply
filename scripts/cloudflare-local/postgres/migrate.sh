#!/usr/bin/env sh
set -eu

database="${POSTGRES_DB:-meltiply}"
admin="${POSTGRES_USER:-postgres}"
sql_dir="$(dirname "$0")"

run_psql() {
  psql --username "$admin" --dbname "$database" --set ON_ERROR_STOP=1 "$@"
}

run_psql --file "$sql_dir/local-roles.sql"
run_psql <<'SQL'
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  name       text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

for migration in /migrations/*.sql; do
  name="$(basename "$migration")"
  checksum="$(sha256sum "$migration" | awk '{print $1}')"
  recorded="$(
    run_psql --tuples-only --no-align \
      --command "SELECT checksum FROM public.schema_migrations WHERE name = '$name'"
  )"

  if [ -n "$recorded" ]; then
    if [ "$recorded" != "$checksum" ]; then
      echo "migration checksum drift: $name" >&2
      exit 1
    fi
    continue
  fi

  echo "applying migration $name"
  run_psql --file "$migration"
  run_psql --set migration_name="$name" --set migration_checksum="$checksum" <<'SQL'
INSERT INTO public.schema_migrations (name, checksum)
VALUES (:'migration_name', :'migration_checksum');
SQL
done

run_psql --file "$sql_dir/grants.sql"
