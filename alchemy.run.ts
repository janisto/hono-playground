import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import {
  COMPATIBILITY_DATE,
  MIGRATIONS_TABLE,
  RATE_LIMITS,
  STACK_NAME,
  WORKER_BASE_NAME,
} from "./infra/config.js";

export { COMPATIBILITY_DATE, MIGRATIONS_TABLE, RATE_LIMITS, STACK_NAME };

const workerProps = Effect.gen(function* () {
  const stack = yield* Alchemy.Stack;
  const stage = stack.stage;
  const persistent = stage === "prod" || stage === "staging";

  const database = yield* Cloudflare.D1.Database("Database", {
    name: `hono-playground-db-${stage}`,
    jurisdiction: "eu",
    readReplication: { mode: "disabled" },
    migrationsDir: "./drizzle",
    migrationsTable: MIGRATIONS_TABLE,
  }).pipe(Alchemy.RemovalPolicy.retain(persistent));

  const publicNamespaceId = yield* Config.string("PUBLIC_RATE_LIMIT_NAMESPACE_ID");
  const profileReadNamespaceId = yield* Config.string("PROFILE_READ_RATE_LIMIT_NAMESPACE_ID");
  const profileWriteNamespaceId = yield* Config.string("PROFILE_WRITE_RATE_LIMIT_NAMESPACE_ID");

  return {
    name: `${WORKER_BASE_NAME}-${stage}`,
    main: "./src/index.ts",
    url: true,
    compatibility: {
      date: COMPATIBILITY_DATE,
    },
    observability: {
      enabled: true,
      headSamplingRate: 1,
      logs: {
        enabled: true,
        invocationLogs: true,
        headSamplingRate: 1,
        persist: true,
      },
      traces: {
        enabled: true,
        headSamplingRate: 1,
        persist: true,
        propagationPolicy: "accept" as const,
      },
    },
    dev: {
      mode: "worker" as const,
      host: "127.0.0.1",
      port: 8787,
      strictPort: true,
    },
    env: {
      DB: database,
      PUBLIC_RATE_LIMITER: Cloudflare.RateLimit("PUBLIC_RATE_LIMITER", {
        namespaceId: publicNamespaceId,
        simple: RATE_LIMITS.public,
      }),
      PROFILE_READ_RATE_LIMITER: Cloudflare.RateLimit("PROFILE_READ_RATE_LIMITER", {
        namespaceId: profileReadNamespaceId,
        simple: RATE_LIMITS.profileRead,
      }),
      PROFILE_WRITE_RATE_LIMITER: Cloudflare.RateLimit("PROFILE_WRITE_RATE_LIMITER", {
        namespaceId: profileWriteNamespaceId,
        simple: RATE_LIMITS.profileWrite,
      }),
      CF_VERSION_METADATA: Cloudflare.VersionMetadata("CF_VERSION_METADATA"),
      ENVIRONMENT:
        stage === "prod" ? "production" : stage === "staging" ? "staging" : "development",
      MAX_REQUEST_SIZE_BYTES: 1_000_000,
      RATE_LIMIT_MODE: "workers-binding",
      ACCESS_TEAM_DOMAIN: Config.string("ACCESS_TEAM_DOMAIN"),
      ACCESS_AUD: Config.string("ACCESS_AUD"),
      RATE_LIMIT_KEY_HMAC_KEY: Config.redacted("RATE_LIMIT_KEY_HMAC_KEY"),
      AUDIT_SUBJECT_HMAC_KEY: Config.redacted("AUDIT_SUBJECT_HMAC_KEY"),
    },
  };
});

export const Worker = Cloudflare.Worker("Worker", workerProps);
export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;

export default Alchemy.Stack(
  STACK_NAME,
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Worker;
    return {
      stage: (yield* Alchemy.Stack).stage,
      workerName: worker.workerName,
      workerUrl: worker.url,
      databaseId: (yield* Cloudflare.D1.Database.ref("Database")).databaseId,
    };
  }),
);
