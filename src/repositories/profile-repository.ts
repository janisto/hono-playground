import { and, eq, ne, or, type SQL, sql } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import type { OperatorCode } from "../core/errors.ts";
import { type NewProfileRow, type ProfileRow, profiles } from "../db/schema.ts";
import { type Profile, type ProfileCreate, ProfileSchema, type ProfileUpdate } from "../models/profile.ts";

const MAX_TIMESTAMP_MILLISECONDS = 253_402_300_799_999;

export const TRANSIENT_D1_ERROR_MESSAGES = [
  "Network connection lost.",
  "D1 DB reset because its code was updated.",
  "Internal error while starting up D1 DB storage caused object to be reset.",
  "Internal error in D1 DB storage caused object to be reset.",
  "Cannot resolve D1 DB due to transient issue on remote node.",
] as const;

const transientMessages = new Set<string>(TRANSIENT_D1_ERROR_MESSAGES);

export interface ProfileRepository {
  create(id: string, input: ProfileCreate, timestamp: Date): Promise<Profile | undefined>;
  get(id: string): Promise<Profile | undefined>;
  update(id: string, input: ProfileUpdate, timestamp: Date): Promise<Profile | undefined>;
  delete(id: string): Promise<boolean>;
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

const messages = (error: unknown): string[] => {
  const result: string[] = [];
  let current = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current === "string") {
      result.push(current);
      break;
    }
    if (!(current instanceof Error)) break;
    result.push(current.message);
    current = current.cause;
  }
  return result;
};

export const isRetryableD1Error = (error: unknown): boolean =>
  messages(error).some((message) => transientMessages.has(message.replace(/^D1_ERROR: /u, "")));

const repositoryError = (error: unknown): ProfileRepositoryError => {
  if (error instanceof ProfileRepositoryError) return error;
  return isRetryableD1Error(error) ? new ProfileRepositoryUnavailableError() : new ProfileRepositoryError();
};

const profileFromRow = (row: ProfileRow): Profile => {
  const parsed = ProfileSchema.safeParse({
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    contactEmail: row.email,
    phoneNumber: row.phoneNumber,
    marketingOptIn: row.marketingOptIn,
    termsAccepted: row.termsAccepted,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  if (!parsed.success) throw new ProfileRepositoryError();
  return parsed.data;
};

const oneProfile = (rows: readonly ProfileRow[]): Profile => {
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) throw new ProfileRepositoryError();
  return profileFromRow(row);
};

const differs = (profile: Profile, input: ProfileUpdate): boolean =>
  (Object.entries(input) as [keyof ProfileUpdate, ProfileUpdate[keyof ProfileUpdate]][]).some(
    ([key, value]) => profile[key] !== value,
  );

export class DrizzleProfileRepository implements ProfileRepository {
  readonly #database: DrizzleD1Database;

  constructor(database: D1Database) {
    this.#database = drizzle(database);
  }

  async create(id: string, input: ProfileCreate, timestamp: Date): Promise<Profile | undefined> {
    const row: NewProfileRow = {
      id,
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.contactEmail,
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
      return inserted.length === 0 ? undefined : oneProfile(inserted);
    } catch (error) {
      throw repositoryError(error);
    }
  }

  async get(id: string): Promise<Profile | undefined> {
    try {
      const selected = await this.#database.select().from(profiles).where(eq(profiles.id, id)).limit(2);
      return selected.length === 0 ? undefined : oneProfile(selected);
    } catch (error) {
      throw repositoryError(error);
    }
  }

  async update(id: string, input: ProfileUpdate, timestamp: Date): Promise<Profile | undefined> {
    const timestampMilliseconds = timestamp.getTime();
    const changes: {
      firstName?: string;
      lastName?: string;
      email?: string;
      phoneNumber?: string;
      marketingOptIn?: boolean;
      updatedAt: SQL;
    } = {
      updatedAt: sql`CASE WHEN ${profiles.updatedAt} < ${timestampMilliseconds} THEN ${timestampMilliseconds} ELSE ${profiles.updatedAt} + 1 END`,
    };
    const changed: SQL[] = [];
    if (input.firstName !== undefined) {
      changes.firstName = input.firstName;
      changed.push(ne(profiles.firstName, input.firstName));
    }
    if (input.lastName !== undefined) {
      changes.lastName = input.lastName;
      changed.push(ne(profiles.lastName, input.lastName));
    }
    if (input.contactEmail !== undefined) {
      changes.email = input.contactEmail;
      changed.push(ne(profiles.email, input.contactEmail));
    }
    if (input.phoneNumber !== undefined) {
      changes.phoneNumber = input.phoneNumber;
      changed.push(ne(profiles.phoneNumber, input.phoneNumber));
    }
    if (input.marketingOptIn !== undefined) {
      changes.marketingOptIn = input.marketingOptIn;
      changed.push(ne(profiles.marketingOptIn, input.marketingOptIn));
    }
    if (changed.length === 0) throw new ProfileRepositoryError();

    try {
      const updated = await this.#database
        .update(profiles)
        .set(changes)
        .where(and(eq(profiles.id, id), or(...changed), sql`${profiles.updatedAt} < ${MAX_TIMESTAMP_MILLISECONDS}`))
        .returning();
      if (updated.length > 0) return oneProfile(updated);
      const current = await this.get(id);
      if (current === undefined) return undefined;
      if (!differs(current, input)) return current;
      if (current.updatedAt.getTime() === MAX_TIMESTAMP_MILLISECONDS) throw new ProfileRepositoryError();
      throw new ProfileRepositoryError();
    } catch (error) {
      throw repositoryError(error);
    }
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
}
