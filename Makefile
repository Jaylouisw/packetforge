# PacketForge -- language-agnostic local entry points.
#
# These mirror the GitHub Actions pipeline so the same gates run in both places.
# `npm run ci` is the canonical command; these are thin wrappers for contributors
# who reach for `make` first. `lint-workflows` is the one target with a
# dependency: it runs actionlint in Docker, exactly as CI does.

.PHONY: check check-fast test ci lint-workflows docker serve hooks list-tests clean

check: ## fast static gates (syntax + control bytes + catalogue audit)
	npm run check

check-fast: ## quickest gate, used by the pre-commit hook
	npm run check:fast

test: ## every test/*.test.js, all failures reported
	npm test

ci: ## full local mirror of the GitHub pipeline
	npm run ci

lint-workflows: ## actionlint over .github/workflows (in Docker, like CI)
	docker run --rm -v "$(CURDIR):/repo" rhysd/actionlint:latest -color

docker: ## build the image locally
	docker build -t packetforge:local .

serve: ## run the server on http://localhost:8000
	node server/index.js

hooks: ## install the pre-commit gate (core.hooksPath = .githooks)
	bash scripts/install-hooks.sh

list-tests: ## print the test files the suite will run
	node scripts/run-tests.js --list

clean: ## remove scratch artifacts (not user boards in data/)
	rm -rf .tmp-*
