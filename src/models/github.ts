import { z } from "@hono/zod-openapi";
import { isAbsoluteHttpUri } from "../core/uri.ts";
import { SafeIntegerSchema, TimestampSchema } from "./portable.ts";

const GIT_SHA_PATTERN = "^(?:[0-9a-f]{40}|[0-9a-f]{64})$";
const HttpUrlSchema = z
  .string()
  .refine(isAbsoluteHttpUri, { error: "Expected an absolute HTTP(S) URL" })
  .openapi({ format: "uri", pattern: "^[Hh][Tt][Tt][Pp][Ss]?://" });
const NonEmptyStringSchema = z.string().min(1);
const NullableNonEmptyStringSchema = NonEmptyStringSchema.nullable();

export const GitHubOwnerPathSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(/^(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9_-]{0,37}[A-Za-z0-9])$/u)
  .openapi({
    minLength: 1,
    maxLength: 39,
    pattern: "^(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9_-]{0,37}[A-Za-z0-9])$",
  });

export const GitHubRepoPathSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^(?=.*[A-Za-z0-9_-])[A-Za-z0-9._-]+$/u)
  .openapi({ minLength: 1, maxLength: 100, pattern: "^(?=.*[A-Za-z0-9_-])[A-Za-z0-9._-]+$" });

export const GitHubOwnerSchema = z
  .strictObject({
    id: SafeIntegerSchema,
    login: NonEmptyStringSchema,
    type: NonEmptyStringSchema,
    name: NullableNonEmptyStringSchema,
    avatarUrl: HttpUrlSchema,
    htmlUrl: HttpUrlSchema,
    company: NullableNonEmptyStringSchema,
    blog: NullableNonEmptyStringSchema,
    location: NullableNonEmptyStringSchema,
    bio: NullableNonEmptyStringSchema,
    publicRepos: SafeIntegerSchema,
    followers: SafeIntegerSchema,
    following: SafeIntegerSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .openapi("GitHubOwner");

const repositorySummaryFields = {
  id: SafeIntegerSchema,
  name: NonEmptyStringSchema,
  fullName: NonEmptyStringSchema,
  description: NullableNonEmptyStringSchema,
  htmlUrl: HttpUrlSchema,
  fork: z.boolean(),
};

export const GitHubRepositorySummarySchema = z.strictObject(repositorySummaryFields).openapi("GitHubRepositorySummary");

export const GitHubRepositorySchema = z
  .strictObject({
    ...repositorySummaryFields,
    language: z.string().nullable(),
    stargazersCount: SafeIntegerSchema,
    forksCount: SafeIntegerSchema,
    openIssuesCount: SafeIntegerSchema,
    archived: z.boolean(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    pushedAt: TimestampSchema.nullable(),
    defaultBranch: NonEmptyStringSchema,
    license: NullableNonEmptyStringSchema,
    topics: z
      .array(z.string())
      .refine((values) => new Set(values).size === values.length, {
        error: "Topics must be unique",
      })
      .openapi({ uniqueItems: true }),
    disabled: z.boolean(),
  })
  .openapi("GitHubRepository");

export const GitHubActivitySchema = z
  .strictObject({
    id: SafeIntegerSchema,
    actor: NullableNonEmptyStringSchema,
    actorAvatarUrl: HttpUrlSchema.nullable(),
    ref: NonEmptyStringSchema,
    timestamp: TimestampSchema,
    activityType: NonEmptyStringSchema,
  })
  .refine((value) => (value.actor === null) === (value.actorAvatarUrl === null), {
    error: "Actor fields must be consistently nullable",
  })
  .openapi("GitHubActivity");

export const GitHubLanguageSchema = z
  .strictObject({ name: NonEmptyStringSchema, bytes: SafeIntegerSchema })
  .openapi("GitHubLanguage");

export const GitHubTagSchema = z
  .strictObject({
    name: NonEmptyStringSchema,
    commit: z.strictObject({
      sha: z.string().regex(new RegExp(GIT_SHA_PATTERN, "u")).openapi({ pattern: GIT_SHA_PATTERN }),
    }),
  })
  .openapi("GitHubTag");

export const GitHubRepositoryPageSchema = z
  .strictObject({
    repos: z.array(GitHubRepositorySummarySchema).max(100),
    count: z.int().min(0).max(100),
  })
  .openapi("GitHubRepositoryPage");

export const GitHubActivityPageSchema = z
  .strictObject({
    activities: z.array(GitHubActivitySchema).max(100),
    count: z.int().min(0).max(100),
  })
  .openapi("GitHubActivityPage");

export const GitHubLanguagesSchema = z
  .strictObject({ languages: z.array(GitHubLanguageSchema) })
  .openapi("GitHubLanguages");

export const GitHubTagPageSchema = z
  .strictObject({ tags: z.array(GitHubTagSchema).max(100), count: z.int().min(0).max(100) })
  .openapi("GitHubTagPage");

export type GitHubOwner = z.infer<typeof GitHubOwnerSchema>;
export type GitHubRepositorySummary = z.infer<typeof GitHubRepositorySummarySchema>;
export type GitHubRepository = z.infer<typeof GitHubRepositorySchema>;
export type GitHubActivity = z.infer<typeof GitHubActivitySchema>;
export type GitHubLanguage = z.infer<typeof GitHubLanguageSchema>;
export type GitHubTag = z.infer<typeof GitHubTagSchema>;
