set shell := ["zsh", "-cu"]

default:
    @just --list

install:
    pnpm install --frozen-lockfile

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

db-preview:
    pnpm db:preview

db-generate name:
    pnpm db:generate {{ name }}

db-check:
    pnpm db:check

plan stage="staging":
    pnpm infra:plan -- --stage {{ stage }}

deploy stage="staging":
    pnpm infra:deploy -- --stage {{ stage }}

logs stage="prod":
    pnpm infra:logs -- --stage {{ stage }}

tail stage="prod":
    pnpm infra:tail -- --stage {{ stage }}

audit:
    pnpm audit

qa:
    pnpm qa
