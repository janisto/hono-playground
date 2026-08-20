import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  COMPATIBILITY_DATE,
  isRateLimitNamespaceId,
  MIGRATIONS_TABLE,
  RATE_LIMITS,
  STACK_NAME,
  WORKER_BASE_NAME,
} from "./infra/config.ts";
import { deploymentHostname, deploymentStagePolicy, deploymentTraceSamplingRate } from "./infra/stage-policy.ts";
import { parseAccessVerifierConfig } from "./src/auth/access.ts";
import { isValidHmacSecret } from "./src/core/config.ts";

export { COMPATIBILITY_DATE, MIGRATIONS_TABLE, RATE_LIMITS, STACK_NAME };

const RateLimitNamespaceIdSchema = Schema.String.pipe(
  Schema.refine((value): value is string => isRateLimitNamespaceId(value), {
    message: "Expected a positive integer string",
  }),
);

const HmacKeySchema = Schema.String.pipe(
  Schema.refine((value): value is string => isValidHmacSecret(value), {
    message: "Expected a strong lowercase 64-hex key",
  }),
);

const rateLimitNamespaceConfig = (name: string) => Config.schema(RateLimitNamespaceIdSchema, name);

const hmacKeyConfig = (name: string) =>
  Config.schema(
    Schema.RedactedFromValue(HmacKeySchema, {
      label: name,
      disallowEncode: true,
    }),
    name,
  );

const accessTeamDomain = Config.string("ACCESS_TEAM_DOMAIN");
const accessAudience = Config.string("ACCESS_AUD");
const rateLimitHmacKey = hmacKeyConfig("RATE_LIMIT_KEY_HMAC_KEY");
const auditSubjectHmacKey = hmacKeyConfig("AUDIT_SUBJECT_HMAC_KEY");

const workerProps = Effect.gen(function* () {
  const stack = yield* Alchemy.Stack;
  const stage = stack.stage;
  const stagePolicy = deploymentStagePolicy(stage);
  const domain =
    stage === "prod" || stage === "staging"
      ? deploymentHostname(stage, yield* Config.string("WORKER_DOMAIN"))
      : undefined;

  const namespaceIds = yield* Config.all({
    public: rateLimitNamespaceConfig("PUBLIC_RATE_LIMIT_NAMESPACE_ID"),
    profileRead: rateLimitNamespaceConfig("PROFILE_READ_RATE_LIMIT_NAMESPACE_ID"),
    profileWrite: rateLimitNamespaceConfig("PROFILE_WRITE_RATE_LIMIT_NAMESPACE_ID"),
  }).pipe(
    Config.mapOrFail((values) =>
      Schema.decodeUnknownEffect(
        Schema.Struct({
          public: RateLimitNamespaceIdSchema,
          profileRead: RateLimitNamespaceIdSchema,
          profileWrite: RateLimitNamespaceIdSchema,
        }).pipe(
          Schema.refine(
            (candidate): candidate is typeof candidate =>
              new Set(Object.values(candidate)).size === Object.keys(candidate).length,
            { message: "Rate limit namespace IDs must be distinct" },
          ),
        ),
      )(values).pipe(Effect.mapError((error) => new Config.ConfigError(error))),
    ),
  );
  yield* Config.all({
    teamDomain: accessTeamDomain,
    audience: accessAudience,
  }).pipe(
    Config.mapOrFail((values) =>
      Schema.decodeUnknownEffect(
        Schema.Struct({
          teamDomain: Schema.String,
          audience: Schema.String,
        }).pipe(
          Schema.refine(
            (candidate): candidate is typeof candidate => {
              try {
                parseAccessVerifierConfig(candidate);
                return true;
              } catch {
                return false;
              }
            },
            { message: "Expected valid Cloudflare Access team domain and audience" },
          ),
        ),
      )(values).pipe(Effect.mapError((error) => new Config.ConfigError(error))),
    ),
  );
  yield* Config.all({
    rateLimit: rateLimitHmacKey,
    auditSubject: auditSubjectHmacKey,
  }).pipe(
    Config.mapOrFail((values) =>
      Schema.decodeUnknownEffect(
        Schema.Struct({
          rateLimit: Schema.Redacted(HmacKeySchema),
          auditSubject: Schema.Redacted(HmacKeySchema),
        }).pipe(
          Schema.refine(
            (candidate): candidate is typeof candidate =>
              Redacted.value(candidate.rateLimit) !== Redacted.value(candidate.auditSubject),
            { message: "Rate limit and audit HMAC keys must be distinct" },
          ),
        ),
      )(values).pipe(Effect.mapError((error) => new Config.ConfigError(error))),
    ),
  );

  const database = yield* Cloudflare.D1.Database("Database", {
    name: `hono-playground-db-${stage}`,
    jurisdiction: "eu",
    readReplication: { mode: "disabled" },
    migrationsDir: "./drizzle",
    migrationsTable: MIGRATIONS_TABLE,
  }).pipe(Alchemy.RemovalPolicy.retain(stagePolicy.persistent));

  return {
    name: `${WORKER_BASE_NAME}-${stage}`,
    main: "./src/index.ts",
    url: false,
    ...(domain === undefined ? {} : { domain }),
    compatibility: {
      date: COMPATIBILITY_DATE,
      flags: ["enable_request_signal", "request_signal_passthrough"],
    },
    observability: {
      enabled: true,
      logs: {
        enabled: true,
        invocationLogs: true,
        headSamplingRate: 1,
        persist: true,
      },
      traces: {
        enabled: true,
        headSamplingRate: deploymentTraceSamplingRate(stagePolicy.environment),
        persist: true,
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
        namespaceId: namespaceIds.public,
        simple: RATE_LIMITS.public,
      }),
      PROFILE_READ_RATE_LIMITER: Cloudflare.RateLimit("PROFILE_READ_RATE_LIMITER", {
        namespaceId: namespaceIds.profileRead,
        simple: RATE_LIMITS.profileRead,
      }),
      PROFILE_WRITE_RATE_LIMITER: Cloudflare.RateLimit("PROFILE_WRITE_RATE_LIMITER", {
        namespaceId: namespaceIds.profileWrite,
        simple: RATE_LIMITS.profileWrite,
      }),
      CF_VERSION_METADATA: Cloudflare.VersionMetadata("CF_VERSION_METADATA"),
      ENVIRONMENT: stagePolicy.environment,
      MAX_REQUEST_SIZE_BYTES: 1_000_000,
      RATE_LIMIT_MODE: "workers-binding",
      ACCESS_TEAM_DOMAIN: accessTeamDomain,
      ACCESS_AUD: accessAudience,
      PUBLIC_ORIGIN: domain === undefined ? "https://hono-playground.dev" : `https://${domain}`,
      RATE_LIMIT_KEY_HMAC_KEY: rateLimitHmacKey,
      AUDIT_SUBJECT_HMAC_KEY: auditSubjectHmacKey,
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
