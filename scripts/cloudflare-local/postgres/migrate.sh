#!/usr/bin/env sh
set -eu

database="${POSTGRES_DB:-meltiply}"
admin="${POSTGRES_USER:-postgres}"

psql --username "$admin" --dbname "$database" --set ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_system') THEN
    CREATE ROLE meltiply_system
      LOGIN
      PASSWORD 'meltiply-system-local'
      BYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_rls') THEN
    CREATE ROLE meltiply_rls
      LOGIN
      PASSWORD 'meltiply-authenticated-local'
      NOBYPASSRLS;
  END IF;
END;
$$;

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
    psql --username "$admin" --dbname "$database" --tuples-only --no-align \
      --set ON_ERROR_STOP=1 \
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
  psql --username "$admin" --dbname "$database" --set ON_ERROR_STOP=1 \
    --file "$migration"
  psql --username "$admin" --dbname "$database" --set ON_ERROR_STOP=1 \
    --set migration_name="$name" --set migration_checksum="$checksum" <<'SQL'
INSERT INTO public.schema_migrations (name, checksum)
VALUES (:'migration_name', :'migration_checksum');
SQL
done

psql --username "$admin" --dbname "$database" --set ON_ERROR_STOP=1 <<'SQL'
GRANT CONNECT ON DATABASE meltiply TO meltiply_system, meltiply_rls;
GRANT USAGE ON SCHEMA public TO meltiply_system;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO meltiply_system;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO meltiply_system;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO meltiply_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO meltiply_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO meltiply_system;
ALTER ROLE meltiply_rls NOBYPASSRLS;
SQL
