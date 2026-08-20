import { AppError, internalError } from "../core/errors.ts";
import type { Profile, ProfileCreate, ProfileUpdate } from "../models/profile.ts";
import {
  type ProfileRepository,
  ProfileRepositoryError,
  ProfileRepositoryUnavailableError,
} from "../repositories/profile-repository.ts";

export type ProfileClock = () => Date;

const notFound = (): AppError => new AppError({ code: "profile_not_found" });
const exists = (): AppError => new AppError({ code: "profile_exists" });
const unavailable = (): AppError =>
  new AppError({ code: "dependency_unavailable", operatorCode: "profile_database_unavailable" });

export class ProfileService {
  readonly #repository: ProfileRepository;
  readonly #now: ProfileClock;

  constructor(repository: ProfileRepository, now: ProfileClock = () => new Date()) {
    this.#repository = repository;
    this.#now = now;
  }

  async create(subject: string, input: ProfileCreate): Promise<Profile> {
    const profile = await this.#repositoryCall(() => this.#repository.create(subject, input, this.#timestamp()));
    if (profile === undefined) throw exists();
    return profile;
  }

  async get(subject: string): Promise<Profile> {
    const profile = await this.#repositoryCall(() => this.#repository.get(subject));
    if (profile === undefined) throw notFound();
    return profile;
  }

  async update(subject: string, input: ProfileUpdate): Promise<Profile> {
    const profile = await this.#repositoryCall(() => this.#repository.update(subject, input, this.#timestamp()));
    if (profile === undefined) throw notFound();
    return profile;
  }

  async delete(subject: string): Promise<void> {
    if (!(await this.#repositoryCall(() => this.#repository.delete(subject)))) throw notFound();
  }

  #timestamp(): Date {
    try {
      const source = this.#now();
      const value = source.getTime();
      if (!Number.isFinite(value) || value < 0 || value > 253_402_300_799_999) throw new TypeError("invalid clock");
      const timestamp = new Date(Math.trunc(value));
      if (!/^[0-9]{4}-/u.test(timestamp.toISOString())) throw new TypeError("clock outside timestamp domain");
      return timestamp;
    } catch {
      throw internalError();
    }
  }

  async #repositoryCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof ProfileRepositoryUnavailableError) throw unavailable();
      if (error instanceof ProfileRepositoryError) throw internalError(error.operatorCode);
      throw internalError();
    }
  }
}
