set shell := ["zsh", "-cu"]

dev_stage := "dev_" + env("USER", "")

default:
    @just --list

install:
    pnpm install --frozen-lockfile

dev:
    @true {{ assert(dev_stage =~ '^dev_[a-z0-9][-_a-z0-9]*$', "USER must produce a valid personal dev_<name> stage") }}
    @true {{ assert(path_exists(".env.dev") == "true", "missing .env.dev; copy .env.example to .env.dev and configure it") }}
    pnpm dev --stage {{ quote(dev_stage) }} --env-file .env.dev --profile dev

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

plan environment:
    @true {{ assert(environment =~ '^(staging|prod)$', "environment must be staging or prod") }}
    @true {{ assert(path_exists(".env." + environment) == "true", "missing .env." + environment + "; copy .env.example and configure it") }}
    pnpm infra:plan --stage {{ quote(environment) }} --env-file {{ quote(".env." + environment) }} --profile {{ quote(environment) }}

deploy environment:
    @true {{ assert(environment =~ '^(staging|prod)$', "environment must be staging or prod") }}
    @true {{ assert(path_exists(".env." + environment) == "true", "missing .env." + environment + "; copy .env.example and configure it") }}
    pnpm infra:deploy --stage {{ quote(environment) }} --env-file {{ quote(".env." + environment) }} --profile {{ quote(environment) }}

logs environment:
    @true {{ assert(environment =~ '^(dev|staging|prod)$', "environment must be dev, staging, or prod") }}
    @true {{ assert((if environment == "dev" { dev_stage } else { environment }) =~ '^(dev_[a-z0-9][-_a-z0-9]*|staging|prod)$', "USER must produce a valid personal dev_<name> stage") }}
    @true {{ assert(path_exists(".env." + environment) == "true", "missing .env." + environment + "; copy .env.example and configure it") }}
    pnpm infra:logs --stage {{ quote(if environment == "dev" { dev_stage } else { environment }) }} --env-file {{ quote(".env." + environment) }} --profile {{ quote(environment) }}

tail environment:
    @true {{ assert(environment =~ '^(dev|staging|prod)$', "environment must be dev, staging, or prod") }}
    @true {{ assert((if environment == "dev" { dev_stage } else { environment }) =~ '^(dev_[a-z0-9][-_a-z0-9]*|staging|prod)$', "USER must produce a valid personal dev_<name> stage") }}
    @true {{ assert(path_exists(".env." + environment) == "true", "missing .env." + environment + "; copy .env.example and configure it") }}
    pnpm infra:tail --stage {{ quote(if environment == "dev" { dev_stage } else { environment }) }} --env-file {{ quote(".env." + environment) }} --profile {{ quote(environment) }}

audit:
    pnpm audit

qa:
    pnpm qa
