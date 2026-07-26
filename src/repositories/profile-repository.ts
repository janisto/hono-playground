import { and, eq, ne, or, type SQL } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import type { OperatorCode } from "../core/errors.ts";
import { type NewProfileRow, type ProfileRow, profiles } from "../db/schema.ts";
import { type Profile, type ProfileCreate, ProfileSchema, type ProfileUpdate } from "../models/profile.ts";

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

const StoredProfileSchema = z.strictObject({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  phoneNumber: z.string(),
  marketingOptIn: z.boolean(),
  termsAccepted: z.literal(true),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export interface ProfileRepository {
  create(id: string, input: ProfileCreate, timestamp: Date): Promise<Profile | undefined>;
  get(id: string): Promise<Profile | undefined>;
  update(id: string, input: ProfileUpdate, timestamp: Date): Promise<Profile | undefined>;
  delete(id: string): Promise<boolean>;
}

export interface DrizzleProfileRepositoryOptions {
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
  errorMessages(error).some((message) => transientD1ErrorMessages.has(removeD1ErrorPrefix(message)));

const repositoryError = (error: unknown): ProfileRepositoryError => {
  if (error instanceof ProfileRepositoryError) return error;
  return isRetryableD1Error(error) ? new ProfileRepositoryUnavailableError() : new ProfileRepositoryError();
};

const profileFromRow = (value: unknown): Profile => {
  const stored = StoredProfileSchema.safeParse(value);
  if (!stored.success) throw new ProfileRepositoryError();

  const row = stored.data;
  const profile = ProfileSchema.safeParse({
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phoneNumber: row.phoneNumber,
    marketingOptIn: row.marketingOptIn,
    termsAccepted: row.termsAccepted,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  if (!profile.success) throw new ProfileRepositoryError();
  if (profile.data.email !== row.email || profile.data.phoneNumber !== row.phoneNumber) {
    throw new ProfileRepositoryError();
  }
  return profile.data;
};

const oneProfile = (rows: readonly ProfileRow[]): Profile => {
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) throw new ProfileRepositoryError();
  return profileFromRow(row);
};

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export class DrizzleProfileRepository implements ProfileRepository {
  readonly #database: DrizzleD1Database;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;

  constructor(database: D1Database, options: DrizzleProfileRepositoryOptions = {}) {
    this.#database = drizzle(database);
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
  }

  async create(id: string, input: ProfileCreate, timestamp: Date): Promise<Profile | undefined> {
    const row: NewProfileRow = {
      id,
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phoneNumber: input.phoneNumber,
      marketingOptIn: input.marketingOptIn,
      termsAccepted: input.termsAccepted,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    try {
      const inserted = await this.#database
        .insert(profiles)
        .values(row)
        .onConflictDoNothing({ target: profiles.id })
        .returning();
      if (inserted.length === 0) return undefined;
      return oneProfile(inserted);
    } catch (error) {
      throw repositoryError(error);
    }
  }

  async get(id: string): Promise<Profile | undefined> {
    try {
      const selected = await this.#database.select().from(profiles).where(eq(profiles.id, id)).limit(2);
      if (selected.length === 0) return undefined;
      return oneProfile(selected);
    } catch (error) {
      throw repositoryError(error);
    }
  }

  async update(id: string, input: ProfileUpdate, timestamp: Date): Promise<Profile | undefined> {
    const changes: Partial<NewProfileRow> = { updatedAt: timestamp };
    const changedPredicates: SQL[] = [];
    if (input.firstName !== undefined) {
      changes.firstName = input.firstName;
      changedPredicates.push(ne(profiles.firstName, input.firstName));
    }
    if (input.lastName !== undefined) {
      changes.lastName = input.lastName;
      changedPredicates.push(ne(profiles.lastName, input.lastName));
    }
    if (input.email !== undefined) {
      changes.email = input.email;
      changedPredicates.push(ne(profiles.email, input.email));
    }
    if (input.phoneNumber !== undefined) {
      changes.phoneNumber = input.phoneNumber;
      changedPredicates.push(ne(profiles.phoneNumber, input.phoneNumber));
    }
    if (input.marketingOptIn !== undefined) {
      changes.marketingOptIn = input.marketingOptIn;
      changedPredicates.push(ne(profiles.marketingOptIn, input.marketingOptIn));
    }

    if (changedPredicates.length === 0) return this.get(id);

    for (let attempt = 0; attempt <= MAX_PATCH_RETRIES; attempt += 1) {
      try {
        const updated = await this.#database
          .update(profiles)
          .set(changes)
          .where(and(eq(profiles.id, id), or(...changedPredicates)))
          .returning();
        if (updated.length === 0) return this.get(id);
        return oneProfile(updated);
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
      const deleted = await this.#database.delete(profiles).where(eq(profiles.id, id)).returning({ id: profiles.id });
      if (deleted.length > 1) throw new ProfileRepositoryError();
      return deleted.length === 1;
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
}
