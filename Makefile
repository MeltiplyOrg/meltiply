SHELL := /bin/sh
.DEFAULT_GOAL := help

BUN ?= bun
FRONTEND_DIR := frontend/app
PUBLIC_SITE_DIR := frontend/public
CLOUDFLARE_LOCAL_DIR := scripts/cloudflare-local

# Make owns environment-aware development workflows. Package checks, database,
# infrastructure, and release commands live directly in package.json (`bun run`).
.PHONY: help setup install doctor dev test build check frontend-boot public-boot frontend-build public-build frontend-preview frontend-test-e2e frontend-e2e-install frontend-e2e-host-deps frontend-lighthouse

help: ## Show daily workflows; use `bun run` for package and operational commands
	@awk 'BEGIN {FS = ":.*## "}; /^[a-zA-Z0-9_.-]+:.*## / {printf "  %-24s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## Install workspace dependencies and prepare the local database
	@CI=true ./$(CLOUDFLARE_LOCAL_DIR)/setup.sh

install: ## Check host tools, prepare the stack, and install the browser runtime
	@./$(CLOUDFLARE_LOCAL_DIR)/install.sh

doctor: ## Diagnose tools, environment, and live services
	@./$(CLOUDFLARE_LOCAL_DIR)/doctor.sh

dev: ## Start PostgreSQL, Workers, app, site, and development tunnels
	@BUN="$(BUN)" ./$(CLOUDFLARE_LOCAL_DIR)/dev.sh

test: ## Run workspace unit tests
	@$(BUN) run test

check: ## Run the complete application validation gate
	@$(BUN) run cloudflare:check

build: ## Build Workers, app, and public site sequentially
	@$(BUN) run workers:build
	@$(MAKE) --no-print-directory frontend-build
	@$(MAKE) --no-print-directory public-build

frontend-boot: ## Start the app using the root environment and strict local port
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
		frontend_port="$${MELTIPLY_FRONTEND_PORT:-$${FRONTEND_DEV_PORT:-3000}}"; \
		dev_host="$$(node ./$(CLOUDFLARE_LOCAL_DIR)/development-host.mjs)"; \
		bind_host="127.0.0.1"; [ "$$dev_host" = "127.0.0.1" ] || bind_host="0.0.0.0"; \
		export FRONTEND_DEV_HOST="$${FRONTEND_DEV_HOST:-$$bind_host}"; \
		export FRONTEND_URL="$${FRONTEND_URL:-http://$$dev_host:$$frontend_port}"; \
		printf 'Frontend using %s\n' "$$FRONTEND_URL"; \
		cd $(FRONTEND_DIR) && $(BUN) run --no-install dev --port "$$frontend_port" --strictPort

public-boot: ## Start the public site and docs using the root environment
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
		public_port="$${PUBLIC_SITE_DEV_PORT:-4321}"; \
		dev_host="$$(node ./$(CLOUDFLARE_LOCAL_DIR)/development-host.mjs)"; \
		bind_host="127.0.0.1"; [ "$$dev_host" = "127.0.0.1" ] || bind_host="0.0.0.0"; \
		export FRONTEND_DEV_HOST="$${FRONTEND_DEV_HOST:-$$bind_host}"; \
		export PUBLIC_SITE_URL="$${PUBLIC_SITE_URL:-http://$$dev_host:$$public_port}"; \
		printf 'Public site using %s (docs at /docs/)\n' "$$PUBLIC_SITE_URL"; \
		cd $(PUBLIC_SITE_DIR) && ASTRO_DEV_BACKGROUND=1 $(BUN) run --no-install dev --host "$$FRONTEND_DEV_HOST" --port "$$public_port"

frontend-build: ## Build the app Worker bundle using the root environment
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
		cd $(FRONTEND_DIR) && $(BUN) run build:production

public-build: ## Build the landing page and documentation using the root environment
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
		cd $(PUBLIC_SITE_DIR) && $(BUN) run build

frontend-preview: ## Preview the built app in the local Workers runtime
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
		cd $(FRONTEND_DIR) && $(BUN) run preview:cloudflare

frontend-test-e2e: ## Run browser journeys with the configured local API and app ports
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
		api_port="$${WRANGLER_DEV_PORT:-8787}"; \
		frontend_port="$${MELTIPLY_FRONTEND_PORT:-$${FRONTEND_DEV_PORT:-3000}}"; \
		export WRANGLER_DEV_PORT="$$api_port"; \
		export MELTIPLY_E2E_API_BASE_URL="http://127.0.0.1:$$api_port"; \
		export MELTIPLY_FRONTEND_PORT="$$frontend_port"; \
		cd $(FRONTEND_DIR) && $(BUN) run test:e2e

frontend-e2e-install: ## Install the pinned Chromium runtime for the current user
	@cd $(FRONTEND_DIR) && $(BUN) run --no-install playwright install chromium

frontend-e2e-host-deps: ## Install Chromium OS libraries using sudo
	@cd $(FRONTEND_DIR) && cmd=$$(command -v $(BUN) || command -v bun) && sudo env "PATH=$$PATH" "$$cmd" run --no-install playwright install-deps chromium

frontend-lighthouse: frontend-build ## Audit the production app build
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
		cd $(FRONTEND_DIR) && $(BUN) run lighthouse
