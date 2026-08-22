import { z } from "zod";
import { isAbsoluteHttpUri } from "../core/uri.ts";
import { SAFE_INTEGER_MAXIMUM } from "../models/portable.ts";

const SafeInteger = z.int().min(0).max(SAFE_INTEGER_MAXIMUM);
const NonEmptyString = z.string().min(1);
const HttpUrl = z.string().refine(isAbsoluteHttpUri);
const DisplayString = z.string().nullable().optional();
const ProviderTimestamp = z.string().refine((value) => canonicalProviderTimestamp(value) !== null);

const repositorySummaryFields = {
  id: SafeInteger,
  name: NonEmptyString,
  full_name: NonEmptyString,
  description: DisplayString,
  html_url: HttpUrl,
  fork: z.boolean(),
  private: z.literal(false),
  visibility: z.literal("public"),
};

export const RawGitHubOwnerSchema = z.looseObject({
  login: NonEmptyString,
  id: SafeInteger,
  avatar_url: HttpUrl,
  html_url: HttpUrl,
  type: NonEmptyString,
  name: DisplayString,
  company: DisplayString,
  blog: DisplayString,
  location: DisplayString,
  bio: DisplayString,
  public_repos: SafeInteger,
  followers: SafeInteger,
  following: SafeInteger,
  created_at: ProviderTimestamp,
  updated_at: ProviderTimestamp,
});

export const RawGitHubRepositorySummarySchema = z.looseObject(repositorySummaryFields);

export const RawGitHubRepositorySchema = z.looseObject({
  ...repositorySummaryFields,
  language: z.string().nullable(),
  stargazers_count: SafeInteger,
  forks_count: SafeInteger,
  open_issues_count: SafeInteger,
  archived: z.boolean(),
  created_at: ProviderTimestamp,
  updated_at: ProviderTimestamp,
  pushed_at: ProviderTimestamp.nullable(),
  default_branch: NonEmptyString,
  license: z.looseObject({ spdx_id: z.string().nullable().optional() }).nullable().optional(),
  topics: z
    .array(z.string())
    .refine((values) => new Set(values).size === values.length)
    .optional(),
  disabled: z.boolean(),
});

export const RawGitHubActivitySchema = z.looseObject({
  id: SafeInteger,
  actor: z.looseObject({ login: NonEmptyString, avatar_url: HttpUrl }).nullable(),
  ref: NonEmptyString,
  timestamp: ProviderTimestamp,
  activity_type: NonEmptyString,
});

export const RawGitHubTagSchema = z.looseObject({
  name: NonEmptyString,
  commit: z.looseObject({ sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u) }),
});

export const RawGitHubRepositoryPageSchema = z.array(RawGitHubRepositorySummarySchema);
export const RawGitHubActivityPageSchema = z.array(RawGitHubActivitySchema);
export const RawGitHubLanguagesSchema = z.record(NonEmptyString, SafeInteger);
export const RawGitHubTagPageSchema = z.array(RawGitHubTagSchema);

export const canonicalProviderTimestamp = (value: string): string | null => {
  const match =
    /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])[Tt]([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(?:\.([0-9]+))?([Zz]|([+-])([01][0-9]|2[0-3]):([0-5][0-9]))$/u.exec(
      value,
    );
  if (match === null) return null;
  const fraction = match[7] ?? "";
  if (fraction.length > 3 && /[^0]/u.test(fraction.slice(3))) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number(fraction.padEnd(3, "0").slice(0, 3));
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second ||
    local.getUTCMilliseconds() !== millisecond
  ) {
    return null;
  }

  const offsetMinutes =
    match[8]?.toUpperCase() === "Z" ? 0 : (match[9] === "+" ? 1 : -1) * (Number(match[10]) * 60 + Number(match[11]));
  const instant = new Date(local.getTime() - offsetMinutes * 60_000);
  const canonical = instant.toISOString();
  return /^[0-9]{4}-/u.test(canonical) ? canonical : null;
};

export type RawGitHubOwner = z.infer<typeof RawGitHubOwnerSchema>;
export type RawGitHubRepositorySummary = z.infer<typeof RawGitHubRepositorySummarySchema>;
export type RawGitHubRepository = z.infer<typeof RawGitHubRepositorySchema>;
export type RawGitHubActivity = z.infer<typeof RawGitHubActivitySchema>;
