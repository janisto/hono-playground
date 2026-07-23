import { AppError, internalError } from "../core/errors.js";
import type { Profile, ProfileCreate, ProfileUpdate } from "../models/profile.js";
import {
  type ProfileRepository,
  ProfileRepositoryError,
  ProfileRepositoryUnavailableError,
} from "../repositories/profile-repository.js";

export type ProfileClock = () => Date;

const profileNotFound = (): AppError =>
  new AppError({ status: 404, code: "not_found", detail: "Profile not found" });

const profileConflict = (): AppError =>
  new AppError({
    status: 409,
    code: "profile_conflict",
    detail: "Profile already exists",
  });

const databaseUnavailable = (retryAfter: boolean): AppError =>
  new AppError({
    status: 503,
    code: "database_unavailable",
    detail: "Database temporarily unavailable",
    ...(retryAfter ? { headers: { "Retry-After": "1" } } : {}),
    operatorCode: "profile_database_unavailable",
  });

export class ProfileService {
  readonly #repository: ProfileRepository;
  readonly #now: ProfileClock;

  constructor(repository: ProfileRepository, now: ProfileClock = () => new Date()) {
    this.#repository = repository;
    this.#now = now;
  }

  async create(subject: string, input: ProfileCreate): Promise<Profile> {
    const profile = await this.#repositoryCall(() =>
      this.#repository.create(subject, input, this.#timestamp()),
    );
    if (profile === undefined) throw profileConflict();
    return profile;
  }

  async get(subject: string): Promise<Profile> {
    const profile = await this.#repositoryCall(() => this.#repository.get(subject), true);
    if (profile === undefined) throw profileNotFound();
    return profile;
  }

  async update(subject: string, input: ProfileUpdate): Promise<Profile> {
    if (Object.keys(input).length === 0) return this.get(subject);

    const profile = await this.#repositoryCall(
      () => this.#repository.update(subject, input, this.#timestamp()),
      true,
    );
    if (profile === undefined) throw profileNotFound();
    return profile;
  }

  async delete(subject: string): Promise<void> {
    const deleted = await this.#repositoryCall(() => this.#repository.delete(subject));
    if (!deleted) throw profileNotFound();
  }

  #timestamp(): string {
    try {
      return this.#now().toISOString();
    } catch {
      throw internalError();
    }
  }

  async #repositoryCall<T>(operation: () => Promise<T>, retryAfter = false): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof ProfileRepositoryUnavailableError) throw databaseUnavailable(retryAfter);
      if (error instanceof ProfileRepositoryError) throw internalError(error.operatorCode);
      throw internalError();
    }
  }
}
