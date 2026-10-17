#!/bin/sh
set -eu
: "${SELFHOST_DB_SYSTEM_PASSWORD:?Set the system database password}"
: "${SELFHOST_DB_AUTHENTICATED_PASSWORD:?Set the authenticated database password}"

# Reuse the canonical migrations, creating their roles with private credentials
# before the development migrator can create its local-only defaults.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL'
\getenv system_password SELFHOST_DB_SYSTEM_PASSWORD
\getenv authenticated_password SELFHOST_DB_AUTHENTICATED_PASSWORD
SELECT 'CREATE ROLE meltiply_system LOGIN BYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_system') \gexec
SELECT 'CREATE ROLE meltiply_rls LOGIN NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_rls') \gexec
SELECT format('ALTER ROLE meltiply_system PASSWORD %L', :'system_password') \gexec
SELECT format('ALTER ROLE meltiply_rls PASSWORD %L', :'authenticated_password') \gexec
SQL
exec sh /local/migrate.sh
