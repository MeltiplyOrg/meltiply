SHELL := /bin/sh

.DEFAULT_GOAL := help

FRONTEND_DIR := frontend/app
PUBLIC_SITE_DIR := frontend/public
BUN ?= bun
CLOUDFLARE_LOCAL_DIR := scripts/cloudflare-local
.PHONY: help setup install doctor dev cloudflare-tunnel-setup test test-integration build check ci frontend-boot frontend-install frontend-format frontend-format-check frontend-type-check frontend-cloudflare-types frontend-lint frontend-audit frontend-test frontend-e2e-install frontend-e2e-host-deps frontend-test-e2e frontend-build frontend-lighthouse frontend-preview cloudflare-setup cloudflare-doctor cloudflare-test-doctor cloudflare-dev cloudflare-api cloudflare-db-start cloudflare-db-migrate cloudflare-db-seed cloudflare-reset cloudflare-seed cloudflare-baseline cloudflare-k6 cloudflare-k6-ci cloudflare-test-k6 cloudflare-teardown cloudflare-smoke cloudflare-processor-smoke cloudflare-local-deploy cloudflare-test cloudflare-test-integration cloudflare-test-local-setup cloudflare-test-teardown cloudflare-test-local-baseline cloudflare-type-check cloudflare-contract-check cloudflare-contract-readiness-generate cloudflare-contract-readiness-check cloudflare-api-test cloudflare-automation-test-integration cloudflare-workers-types cloudflare-workers-type-check cloudflare-workers-test cloudflare-workers-build cloudflare-preview cloudflare-iac-check cloudflare-release-test cloudflare-docs-check cloudflare-format-check cloudflare-check cloudflare-cost-model cloudflare-cost-check cloudflare-cost-require-complete cloudflare-queue-metrics cloudflare-queue-replay cloudflare-package-test cloudflare-test-supply-chain cloudflare-security-supply-chain cloudflare-security-secrets cloudflare-release-preflight-offline cloudflare-release-preflight cloudflare-release-render cloudflare-release-restore-point cloudflare-release-migrate cloudflare-release-deploy cloudflare-release-secrets cloudflare-release-cron cloudflare-test-staging cloudflare-staging-r2-check cloudflare-staging-r2-run cloudflare-wrangler hooks status public-boot public-build
.PHONY: cloudflare-observability-start cloudflare-observability-stop

help: ## Show available targets
	@awk 'BEGIN {FS = ":.*## "}; /^[a-zA-Z0-9_.-]+:.*## / {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: hooks cloudflare-setup ## Set up the local Cloudflare development environment

install: hooks ## Check the toolchain and install every dependency, then verify
	@./$(CLOUDFLARE_LOCAL_DIR)/install.sh

doctor: cloudflare-doctor ## Diagnose toolchain, env, live stack, and Worker processes

dev: ## Start PostgreSQL, Workers, app, public site, and public Cloudflare Quick Tunnels
	@BUN="$(BUN)" ./$(CLOUDFLARE_LOCAL_DIR)/dev.sh

cloudflare-tunnel-setup: ## Create a named tunnel + DNS records (NOT auto-deleted; needs manual cleanup)
	@./$(CLOUDFLARE_LOCAL_DIR)/dev-tunnel.sh setup

test: cloudflare-test ## Run all workspace unit tests

test-integration: cloudflare-test-integration ## Run all workspace integration tests

build: cloudflare-workers-build frontend-build public-build ## Build the Workers, app, and unified public site

frontend-boot: ## Start the frontend development server from the root env
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
		frontend_port="$${MELTIPLY_FRONTEND_PORT:-$${FRONTEND_DEV_PORT:-3000}}"; \
		dev_host="$$(node ./$(CLOUDFLARE_LOCAL_DIR)/development-host.mjs)"; \
		bind_host="127.0.0.1"; [ "$$dev_host" = "127.0.0.1" ] || bind_host="0.0.0.0"; \
		export FRONTEND_DEV_HOST="$${FRONTEND_DEV_HOST:-$$bind_host}"; \
		export FRONTEND_URL="$${FRONTEND_URL:-http://$$dev_host:$$frontend_port}"; \
		printf 'Frontend using %s\n' "$$FRONTEND_URL"; \
		cd $(FRONTEND_DIR) && $(BUN) run --no-install dev --port "$$frontend_port" --strictPort

public-boot: ## Start the unified Astro public site from the root env
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
		public_port="$${PUBLIC_SITE_DEV_PORT:-4321}"; \
		dev_host="$$(node ./$(CLOUDFLARE_LOCAL_DIR)/development-host.mjs)"; \
		bind_host="127.0.0.1"; [ "$$dev_host" = "127.0.0.1" ] || bind_host="0.0.0.0"; \
		export FRONTEND_DEV_HOST="$${FRONTEND_DEV_HOST:-$$bind_host}"; \
		export PUBLIC_SITE_URL="$${PUBLIC_SITE_URL:-http://$$dev_host:$$public_port}"; \
		printf 'Public site using %s (docs at /docs/)\n' "$$PUBLIC_SITE_URL"; \
		cd $(PUBLIC_SITE_DIR) && ASTRO_DEV_BACKGROUND=1 $(BUN) run --no-install dev --host "$$FRONTEND_DEV_HOST" --port "$$public_port"


frontend-install: ## Install frontend dependencies
	@cd $(FRONTEND_DIR) && $(BUN) install

frontend-format: ## Format frontend source files
	@cd $(FRONTEND_DIR) && $(BUN) run format

frontend-format-check: ## Check frontend formatting
	@cd $(FRONTEND_DIR) && $(BUN) run format-check

frontend-type-check: ## Run frontend TypeScript checks
	@cd $(FRONTEND_DIR) && $(BUN) run type-check

frontend-cloudflare-types: ## Verify generated frontend Worker binding types
	@cd $(FRONTEND_DIR) && $(BUN) run cf-typegen:check

frontend-lint: ## Run frontend lint checks
	@cd $(FRONTEND_DIR) && $(BUN) run lint

frontend-audit: ## Audit frontend production dependencies
	@cd $(FRONTEND_DIR) && $(BUN) run audit

frontend-test: ## Run frontend unit tests
	@cd $(FRONTEND_DIR) && $(BUN) run test

frontend-e2e-install: ## Install the pinned frontend Chromium runtime for current user
	@cd $(FRONTEND_DIR) && $(BUN) run --no-install playwright install chromium

frontend-e2e-host-deps: ## Install Chromium OS libraries system-wide (requires root/sudo)
	@cd $(FRONTEND_DIR) && cmd=$$(command -v $(BUN) || command -v bun) && sudo env "PATH=$$PATH" "$$cmd" run --no-install playwright install-deps chromium

frontend-test-e2e: ## Run frontend Playwright journeys
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
		api_port="$${WRANGLER_DEV_PORT:-8787}"; \
		frontend_port="$${MELTIPLY_FRONTEND_PORT:-$${FRONTEND_DEV_PORT:-3000}}"; \
		export WRANGLER_DEV_PORT="$$api_port"; \
		export MELTIPLY_E2E_API_BASE_URL="http://127.0.0.1:$$api_port"; \
		export MELTIPLY_FRONTEND_PORT="$$frontend_port"; \
		cd $(FRONTEND_DIR) && $(BUN) run test:e2e

frontend-build: ## Build the frontend Cloudflare Worker bundle
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
		cd $(FRONTEND_DIR) && $(BUN) run build:production

public-build: ## Build the Astro landing page and public documentation together
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
		cd $(PUBLIC_SITE_DIR) && $(BUN) run build

frontend-lighthouse: frontend-build ## Audit the product application with Lighthouse CI
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
		cd $(FRONTEND_DIR) && $(BUN) run lighthouse

frontend-preview: ## Preview the built frontend in the local Workers runtime
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
		cd $(FRONTEND_DIR) && $(BUN) run preview:cloudflare

# Cloudflare target workflow. These targets are the supported Make interface;
# Bun is the pinned workspace runner behind the interface.
cloudflare-setup: ## Set up the Cloudflare-target local stack
	@CI=true ./$(CLOUDFLARE_LOCAL_DIR)/setup.sh

cloudflare-doctor: ## Diagnose the Cloudflare-target local environment end to end
	@./$(CLOUDFLARE_LOCAL_DIR)/doctor.sh

cloudflare-test-doctor: ## Test the doctor diagnostic script hermetically
	@./$(CLOUDFLARE_LOCAL_DIR)/doctor.test.sh

cloudflare-dev: ## Start the local API, Automation, and State Workers
	@./$(CLOUDFLARE_LOCAL_DIR)/dev-backend.sh

cloudflare-api: ## Start only the local API Worker
	@./$(CLOUDFLARE_LOCAL_DIR)/dev-api.sh

cloudflare-db-start: ## Start the target PostgreSQL service and apply migrations
	@./$(CLOUDFLARE_LOCAL_DIR)/database.sh start

cloudflare-db-migrate: ## Apply target PostgreSQL migrations
	@./$(CLOUDFLARE_LOCAL_DIR)/database.sh migrate

cloudflare-db-seed: ## Seed the target PostgreSQL fixtures
	@./$(CLOUDFLARE_LOCAL_DIR)/database.sh seed

cloudflare-observability-start: ## Opt in to the local Grafana, Tempo, Loki, Prometheus, and Pushgateway stack
	@./$(CLOUDFLARE_LOCAL_DIR)/compose.sh --profile observability up -d tempo loki grafana pushgateway prometheus

cloudflare-observability-stop: ## Stop optional observability services without touching PostgreSQL
	@./$(CLOUDFLARE_LOCAL_DIR)/compose.sh --profile observability stop tempo loki grafana pushgateway prometheus

cloudflare-reset: ## Rebuild and seed the target PostgreSQL database
	@./$(CLOUDFLARE_LOCAL_DIR)/reset.sh

cloudflare-seed: ## Seed the target database fixtures
	@$(BUN) run seed

cloudflare-baseline: ## Measure the running local API baseline
	@node scripts/cloudflare-local/measure-public-routes.mjs

cloudflare-k6: ## Run k6 against the live local API and remote-write to Prometheus
	@./$(CLOUDFLARE_LOCAL_DIR)/k6-run.sh

cloudflare-k6-ci: ## CI k6 profile against the live local API
	@./$(CLOUDFLARE_LOCAL_DIR)/k6-run.sh --ci

cloudflare-test-k6: ## Hermetic tests for the k6 runner wiring
	@./$(CLOUDFLARE_LOCAL_DIR)/k6-run.test.sh

cloudflare-teardown: ## Stop Compose observability/DB stack and local Worker leftovers
	@./$(CLOUDFLARE_LOCAL_DIR)/teardown.sh

cloudflare-smoke: ## Run local Worker health, conformance, CORS, and webhook smoke checks
	@./$(CLOUDFLARE_LOCAL_DIR)/smoke.sh

cloudflare-processor-smoke: ## Smoke the native media processor engine in its real linux/amd64 container
	@./$(CLOUDFLARE_LOCAL_DIR)/processor-smoke.sh $(ARGS)

cloudflare-local-deploy: cloudflare-setup cloudflare-workers-build cloudflare-smoke ## Prepare, build, and smoke-test the local target stack

cloudflare-test: ## Run all workspace unit tests
	@$(BUN) run test

cloudflare-test-integration: ## Run target PostgreSQL, API, and Automation integration tests
	@$(BUN) run test:integration

cloudflare-test-local-setup: ## Test the hermetic local-stack bootstrap path
	@./$(CLOUDFLARE_LOCAL_DIR)/setup.test.sh


.PHONY: cloudflare-test-dev

cloudflare-test-dev: ## Test coordinated local development service shutdown
	@./$(CLOUDFLARE_LOCAL_DIR)/dev.test.sh
cloudflare-test-teardown: ## Test shared-runner Compose/Worker teardown
	@./$(CLOUDFLARE_LOCAL_DIR)/teardown.test.sh

cloudflare-test-local-baseline: ## Test local baseline measurement behavior
	@node --test scripts/cloudflare-local/measure-public-routes.test.mjs

cloudflare-type-check: ## Run all workspace TypeScript checks
	@$(BUN) run type-check

cloudflare-contract-check: ## Validate the canonical OpenAPI contract and readiness matrix
	@$(BUN) run contract:check

cloudflare-contract-readiness-generate: ## Generate the endpoint readiness matrix
	@$(BUN) run contract:readiness:generate

cloudflare-contract-readiness-check: ## Verify endpoint readiness metadata and evidence
	@$(BUN) run contract:readiness:check

cloudflare-api-test: ## Run API Worker route and contract tests
	@$(BUN) run --filter @meltiply/api-worker test

cloudflare-automation-test-integration: ## Run Automation Worker PostgreSQL integration tests
	@$(BUN) run --filter @meltiply/automation-worker test:integration

cloudflare-workers-types: ## Generate Worker binding types
	@$(BUN) run workers:types

cloudflare-workers-type-check: ## Run Worker TypeScript checks
	@$(BUN) run workers:type-check

cloudflare-workers-test: ## Run Worker unit tests
	@$(BUN) run workers:test

cloudflare-workers-build: ## Build all Cloudflare Workers with Wrangler dry-run
	@$(BUN) run workers:build

cloudflare-preview: cloudflare-workers-build ## Build the Cloudflare Workers preview artifacts

cloudflare-iac-check: ## Validate OpenTofu, staging plans, and infrastructure policy
	@$(BUN) run iac:check

cloudflare-release-test: ## Run release planner and deployment safety tests
	@$(BUN) run release:test

cloudflare-docs-check: ## Validate documentation links and Fumadocs source pages
	@$(BUN) run docs:check

cloudflare-format-check: ## Check target formatting
	@$(BUN) run format-check:cloudflare

cloudflare-check: ## Run the complete Cloudflare-target quality gate
	@$(BUN) run cloudflare:check

cloudflare-cost-model: ## Emit the versioned cost model
	@$(BUN) run cost:model

cloudflare-cost-check: ## Validate the versioned cost model
	@$(BUN) run cost:check

cloudflare-cost-require-complete: ## Require a complete cost model
	@$(BUN) run cost:require-complete

cloudflare-queue-metrics: ## Inspect Queue and DLQ health; pass ARGS='...'
	@$(BUN) run queue:metrics $(ARGS)

cloudflare-queue-replay: ## Replay a bounded DLQ batch; pass ARGS='...'
	@$(BUN) run queue:replay $(ARGS)

cloudflare-package-test: ## Run one workspace package test; pass PACKAGE='@meltiply/domain'
	@test -n "$(PACKAGE)" || { printf 'Set PACKAGE, for example: make cloudflare-package-test PACKAGE=@meltiply/domain\n'; exit 1; }
	@$(BUN) run --filter "$(PACKAGE)" test

cloudflare-test-supply-chain: ## Run supply-chain policy tests
	@$(BUN) run test:supply-chain

cloudflare-security-supply-chain: ## Classify dependencies and write the SBOM
	@$(BUN) run security:supply-chain $(ARGS)

cloudflare-security-secrets: ## Scan repository history for secrets
	@$(BUN) run security:secrets

cloudflare-release-preflight-offline: ## Validate release inputs without credentials; pass ARGS='...'
	@$(BUN) run release:preflight:offline $(ARGS)

cloudflare-release-preflight: ## Validate release inputs with protected credentials; pass ARGS='...'
	@$(BUN) run release:preflight $(ARGS)

cloudflare-release-render: ## Render private release Worker configs; pass ARGS='...'
	@$(BUN) run release:render $(ARGS)

cloudflare-release-restore-point: ## Create a protected database restore point; pass ARGS='...'
	@$(BUN) run release:restore-point $(ARGS)

cloudflare-release-migrate: ## Apply protected schema migrations; pass ARGS='...'
	@$(BUN) run release:migrate $(ARGS)

cloudflare-release-deploy: ## Deploy a protected Worker phase; pass ARGS='...'
	@$(BUN) run release:deploy $(ARGS)

cloudflare-release-secrets: ## Upload protected Worker secrets from stdin; pass ARGS='...'
	@$(BUN) run release:secrets $(ARGS)

cloudflare-release-cron: ## Pause or activate protected Cron schedules; pass ARGS='...'
	@$(BUN) run release:cron $(ARGS)

cloudflare-test-staging: ## Run protected-staging harness tests
	@$(BUN) run test:staging

cloudflare-staging-r2-check: ## Validate protected R2 acceptance inputs; pass ARGS='...'
	@$(BUN) run staging:r2:check $(ARGS)

cloudflare-staging-r2-run: ## Run protected R2 acceptance; pass ARGS='...'
	@$(BUN) run staging:r2:run $(ARGS)

cloudflare-wrangler: ## Run a Wrangler command; pass ARGS='...'
	@$(BUN) run --no-install wrangler $(ARGS)

ci: cloudflare-check ## Run the CI-equivalent validation workflow

check: cloudflare-check ## Run the main local validation workflow

GH_GUARD_DIR := scripts/gh-guard

hooks: ## Activate the client-side PR-create guard (PATH-shadow gh wrapper)
	@chmod +x $(GH_GUARD_DIR)/gh
	@abs_guard="$$(cd $(GH_GUARD_DIR) && pwd)"; \
	if command -v direnv >/dev/null 2>&1; then \
		printf 'direnv detected. Run:  direnv allow\n'; \
		printf 'Then the guard auto-activates in this repo (via .envrc PATH_add %s).\n' "$(GH_GUARD_DIR)"; \
	else \
		printf 'direnv not found. Add this to your shell profile (or run it now):\n'; \
		printf '  export PATH="%s:$$PATH"\n' "$$abs_guard"; \
	fi; \
	case ":$$PATH:" in \
	*":$$abs_guard:"*) printf '\nGuard is ACTIVE: %s is on PATH.\n' "$$abs_guard"; \
		gh_resolved="$$(command -v gh || true)"; \
		printf 'gh resolves to: %s\n' "$$gh_resolved"; \
		if [ "$$gh_resolved" != "$$abs_guard/gh" ]; then \
			printf 'WARNING: gh does not resolve to the guard; check PATH ordering.\n'; \
		fi ;; \
	*) printf '\nGuard is NOT YET active in this shell (see instructions above).\n' ;; \
	esac

status: ## Show git status in short form
	@git status --short --branch
