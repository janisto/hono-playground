set shell := ["zsh", "-cu"]

default:
    @just --list

install:
    pnpm install --frozen-lockfile

versions:
    node --version
    pnpm --version
    pnpm exec wrangler --version

dev:
    pnpm dev

check:
    pnpm check

typecheck:
    pnpm typecheck

test:
    pnpm test

coverage:
    pnpm coverage

e2e:
    pnpm test:e2e

docs-assets:
    pnpm docs:assets

openapi:
    pnpm openapi:generate

types:
    pnpm types

config-check:
    pnpm config:check

production-check:
    pnpm production:check

licenses-check:
    pnpm licenses:check

db-migrations-list-local:
    pnpm db:migrations:list:local

db-migrations-apply-local:
    pnpm db:migrations:apply:local

db-migrations-list-remote:
    pnpm db:migrations:list:remote

deploy-dry-run:
    pnpm deploy:dry-run

deploy-production:
    pnpm deploy:production

tail:
    pnpm tail

qa:
    pnpm qa
