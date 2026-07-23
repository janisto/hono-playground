import { z } from "zod";

import type { OperatorCode } from "../core/errors.js";
import type { D1Metrics } from "../core/types.js";
import {
  type Profile,
  type ProfileCreate,
  ProfileSchema,
  type ProfileUpdate,
} from "../models/profile.js";

const PROFILE_COLUMNS =
  "id, first_name, last_name, email, phone_number, marketing, terms, created_at, updated_at";

const SELECT_PROFILE_BY_ID = `SELECT ${PROFILE_COLUMNS} FROM profiles WHERE id = ?`;

const INSERT_PROFILE = `
  INSERT INTO profiles (
    id, first_name, last_name, email, phone_number, marketing, terms, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO NOTHING
`;

const DELETE_PROFILE = "DELETE FROM profiles WHERE id = ?";

const UPDATE_FIELDS = [
  "first_name",
  "last_name",
  "email",
  "phone_number",
  "marketing",
] as const satisfies readonly (keyof ProfileUpdate)[];

const MAX_PATCH_RETRIES = 2;
const PATCH_RETRY_BASE_DELAY_MS = 25;
const PATCH_RETRY_MAX_DELAY_MS = 100;

export const TRANSIENT_D1_ERROR_MESSAGES = [
  "Network connection lost.",
  "D1 DB reset because its code was updated.",
  "Internal error while starting up D1 DB storage caused object to be reset.",
  "Internal error in D1 DB storage caused object to be reset.",
  "Cannot resolve D1 DB due to transient issue on remote node.",
] as const;

const transientD1ErrorMessages = new Set<string>(TRANSIENT_D1_ERROR_MESSAGES);

const D1ProfileRowSchema = z
  .object({
    id: z.string(),
    first_name: z.string(),
    last_name: z.string(),
    email: z.string(),
    phone_number: z.string(),
    marketing: z.union([z.literal(0), z.literal(1)]),
    terms: z.literal(1),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

type D1ProfileRow = z.infer<typeof D1ProfileRowSchema>;

export type D1MetadataCallback = (metadata: D1Metrics) => void;

export interface ProfileRepository {
  create(id: string, input: ProfileCreate, timestamp: string): Promise<Profile | undefined>;
  get(id: string): Promise<Profile | undefined>;
  update(id: string, input: ProfileUpdate, timestamp: string): Promise<Profile | undefined>;
  delete(id: string): Promise<boolean>;
}

export interface D1ProfileRepositoryOptions {
  readonly onMetadata?: D1MetadataCallback;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
}

export class ProfileRepositoryError extends Error {
  readonly operatorCode: OperatorCode = "profile_repository_failure";

  constructor() {
    super("profile repository failure");
    this.name = "ProfileRepositoryError";
  }
}

export class ProfileRepositoryUnavailableError extends ProfileRepositoryError {
  override readonly operatorCode = "profile_database_unavailable";

  constructor() {
    super();
    this.name = "ProfileRepositoryUnavailableError";
  }
}

const errorMessages = (error: unknown): string[] => {
  const messages: string[] = [];
  let current = error;

  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current === "string") {
      messages.push(current);
      break;
    }
    if (!(current instanceof Error)) break;
    messages.push(current.message);
    current = current.cause;
  }

  return messages;
};

const removeD1ErrorPrefix = (message: string): string =>
  message.startsWith("D1_ERROR: ") ? message.slice("D1_ERROR: ".length) : message;

export const isRetryableD1Error = (error: unknown): boolean =>
  errorMessages(error).some((message) =>
    transientD1ErrorMessages.has(removeD1ErrorPrefix(message)),
  );

const repositoryError = (error: unknown): ProfileRepositoryError => {
  if (error instanceof ProfileRepositoryError) return error;
  return isRetryableD1Error(error)
    ? new ProfileRepositoryUnavailableError()
    : new ProfileRepositoryError();
};

const profileFromRow = (value: unknown): Profile => {
  const stored = D1ProfileRowSchema.safeParse(value);
  if (!stored.success) throw new ProfileRepositoryError();

  const row: D1ProfileRow = stored.data;
  const profile = ProfileSchema.safeParse({
    ...row,
    marketing: row.marketing === 1,
    terms: true,
  });
  if (!profile.success) throw new ProfileRepositoryError();
  if (profile.data.email !== row.email || profile.data.phone_number !== row.phone_number) {
    throw new ProfileRepositoryError();
  }
  return profile.data;
};

const profilesFromResult = (result: D1Result<unknown>): Profile[] =>
  result.results.map(profileFromRow);

const oneProfile = (profiles: readonly Profile[]): Profile => {
  const profile = profiles[0];
  if (profiles.length !== 1 || profile === undefined) throw new ProfileRepositoryError();
  return profile;
};

const integerBoolean = (value: boolean): 0 | 1 => (value ? 1 : 0);

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export class D1ProfileRepository implements ProfileRepository {
  readonly #database: D1Database;
  readonly #onMetadata: D1MetadataCallback | undefined;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;

  constructor(database: D1Database, options: D1ProfileRepositoryOptions = {}) {
    this.#database = database;
    this.#onMetadata = options.onMetadata;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
  }

  async create(id: string, input: ProfileCreate, timestamp: string): Promise<Profile | undefined> {
    try {
      const results = await this.#database.batch<unknown>([
        this.#database
          .prepare(INSERT_PROFILE)
          .bind(
            id,
            input.first_name,
            input.last_name,
            input.email,
            input.phone_number,
            integerBoolean(input.marketing),
            integerBoolean(input.terms),
            timestamp,
            timestamp,
          ),
        this.#database.prepare(SELECT_PROFILE_BY_ID).bind(id),
      ]);
      this.#recordMetadata(results);

      const mutation = results[0];
      const selection = results[1];
      if (mutation === undefined || selection === undefined || results.length !== 2) {
        throw new ProfileRepositoryError();
      }

      const selectedProfiles = profilesFromResult(selection);
      if (mutation.meta.changes === 0) {
        oneProfile(selectedProfiles);
        return undefined;
      }
      if (mutation.meta.changes !== 1) throw new ProfileRepositoryError();
      return oneProfile(selectedProfiles);
    } catch (error) {
      throw repositoryError(error);
    }
  }

  async get(id: string): Promise<Profile | undefined> {
    try {
      const result = await this.#database.prepare(SELECT_PROFILE_BY_ID).bind(id).run<unknown>();
      this.#recordMetadata([result]);

      const profiles = profilesFromResult(result);
      if (profiles.length === 0) return undefined;
      return oneProfile(profiles);
    } catch (error) {
      throw repositoryError(error);
    }
  }

  async update(id: string, input: ProfileUpdate, timestamp: string): Promise<Profile | undefined> {
    const fields = UPDATE_FIELDS.filter((field) => Object.hasOwn(input, field));
    if (fields.length === 0) return this.get(id);

    const assignments = fields.map((field) => `${field} = ?`);
    assignments.push("updated_at = ?");
    const sql = `UPDATE profiles SET ${assignments.join(", ")} WHERE id = ?`;
    const values = fields.map((field) => {
      const value = input[field];
      return field === "marketing" && typeof value === "boolean" ? integerBoolean(value) : value;
    });
    const bindings = [...values, timestamp, id];

    for (let attempt = 0; attempt <= MAX_PATCH_RETRIES; attempt += 1) {
      try {
        const results = await this.#database.batch<unknown>([
          this.#database.prepare(sql).bind(...bindings),
          this.#database.prepare(SELECT_PROFILE_BY_ID).bind(id),
        ]);
        this.#recordMetadata(results);

        const mutation = results[0];
        const selection = results[1];
        if (mutation === undefined || selection === undefined || results.length !== 2) {
          throw new ProfileRepositoryError();
        }

        const selectedProfiles = profilesFromResult(selection);
        if (mutation.meta.changes === 0) {
          if (selectedProfiles.length !== 0) throw new ProfileRepositoryError();
          return undefined;
        }
        if (mutation.meta.changes !== 1) throw new ProfileRepositoryError();
        return oneProfile(selectedProfiles);
      } catch (error) {
        if (error instanceof ProfileRepositoryError || !isRetryableD1Error(error)) {
          throw repositoryError(error);
        }
        if (attempt === MAX_PATCH_RETRIES) {
          throw new ProfileRepositoryUnavailableError();
        }

        try {
          await this.#sleep(this.#retryDelay(attempt));
        } catch {
          throw new ProfileRepositoryError();
        }
      }
    }

    throw new ProfileRepositoryError();
  }

  async delete(id: string): Promise<boolean> {
    try {
      const result = await this.#database.prepare(DELETE_PROFILE).bind(id).run();
      this.#recordMetadata([result]);

      if (result.meta.changes === 0) return false;
      if (result.meta.changes !== 1) throw new ProfileRepositoryError();
      return true;
    } catch (error) {
      throw repositoryError(error);
    }
  }

  #retryDelay(attempt: number): number {
    const baseDelay = Math.min(PATCH_RETRY_BASE_DELAY_MS * 2 ** attempt, PATCH_RETRY_MAX_DELAY_MS);
    const randomValue = Math.max(0, Math.min(1, this.#random()));
    const jitter = Math.floor(randomValue * baseDelay);
    return Math.min(baseDelay + jitter, PATCH_RETRY_MAX_DELAY_MS);
  }

  #recordMetadata(results: readonly D1Result<unknown>[]): void {
    if (this.#onMetadata === undefined) return;

    const metadata = results.reduce<D1Metrics>(
      (total, result) => ({
        durationMs: total.durationMs + result.meta.duration,
        rowsRead: total.rowsRead + result.meta.rows_read,
        rowsWritten: total.rowsWritten + result.meta.rows_written,
      }),
      { durationMs: 0, rowsRead: 0, rowsWritten: 0 },
    );

    try {
      this.#onMetadata(metadata);
    } catch {
      // Observability must never change a committed database outcome.
    }
  }
}
