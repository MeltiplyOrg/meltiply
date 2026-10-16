#!/usr/bin/env sh
set -eu

/local/migrate.sh
/local/seed.sh
touch "$PGDATA/.meltiply-init-complete"
