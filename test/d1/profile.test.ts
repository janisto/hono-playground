import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import { AppError } from "../../src/core/errors.js";
import { type ProfileCreate, ProfileCreateSchema } from "../../src/models/profile.js";
import {
  D1ProfileRepository,
  ProfileRepositoryError,
} from "../../src/repositories/profile-repository.js";
import { ProfileService } from "../../src/services/profile-service.js";

const database = (env as unknown as { readonly DB: D1Database }).DB;
const trackedIds = new Set<string>();

const profileId = (): string => {
  const id = `profile-test-${crypto.randomUUID()}`;
  trackedIds.add(id);
  return id;
};

const input = (overrides: Partial<ProfileCreate> = {}): ProfileCreate =>
  ProfileCreateSchema.parse({
    first_name: "Ada",
    last_name: "Lovelace",
    email: "ADA@example.com ",
    phone_number: " +358401234567 ",
    terms: true,
    ...overrides,
  });

const appError = async (operation: Promise<unknown>): Promise<AppError> => {
  try {
    await operation;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("Expected an AppError");
};

afterEach(async () => {
  const ids = [...trackedIds];
  trackedIds.clear();
  if (ids.length === 0) return;
  await database.batch(
    ids.map((id) => database.prepare("DELETE FROM profiles WHERE id = ?").bind(id)),
  );
});

describe("D1 profile lifecycle", () => {
  it("creates, reads, patches, preserves created_at, reads an empty patch, and deletes", async () => {
    const id = profileId();
    const timestamps = [new Date("2026-07-22T10:00:00.000Z"), new Date("2026-07-22T11:00:00.000Z")];
    const repository = new D1ProfileRepository(database);
    const service = new ProfileService(repository, () => {
      const timestamp = timestamps.shift();
      if (timestamp === undefined) throw new Error("unexpected clock read");
      return timestamp;
    });

    const created = await service.create(id, input());
    expect(created).toEqual({
      id,
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@example.com",
      phone_number: "+358401234567",
      marketing: false,
      terms: true,
      created_at: "2026-07-22T10:00:00.000Z",
      updated_at: "2026-07-22T10:00:00.000Z",
    });
    await expect(service.get(id)).resolves.toEqual(created);

    const updated = await service.update(id, { first_name: "Grace", marketing: true });
    expect(updated).toMatchObject({
      id,
      first_name: "Grace",
      marketing: true,
      created_at: created.created_at,
      updated_at: "2026-07-22T11:00:00.000Z",
    });
    await expect(service.update(id, {})).resolves.toEqual(updated);
    expect(timestamps).toHaveLength(0);

    await expect(service.delete(id)).resolves.toBeUndefined();
    const missing = await appError(service.get(id));
    expect(missing).toMatchObject({
      status: 404,
      code: "not_found",
      detail: "Profile not found",
    });
    await expect(service.delete(id)).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("serializes concurrent creates into one success, one conflict, and one stored row", async () => {
    const id = profileId();
    const service = new ProfileService(
      new D1ProfileRepository(database),
      () => new Date("2026-07-22T10:00:00.000Z"),
    );

    const outcomes = await Promise.allSettled([
      service.create(id, input({ first_name: "Ada" })),
      service.create(id, input({ first_name: "Grace" })),
    ]);
    const successes = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const failures = outcomes.filter((outcome) => outcome.status === "rejected");

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toBeInstanceOf(AppError);
    expect(failures[0]?.reason).toMatchObject({ status: 409, code: "profile_conflict" });

    const count = await database
      .prepare("SELECT COUNT(*) AS count FROM profiles WHERE id = ?")
      .bind(id)
      .first<number>("count");
    expect(count).toBe(1);
    await expect(service.get(id)).resolves.toMatchObject({
      id,
      first_name: expect.stringMatching(/^(Ada|Grace)$/),
    });
  });

  it("keeps concurrent PATCH behavior last-commit-wins with internally consistent snapshots", async () => {
    const id = profileId();
    const repository = new D1ProfileRepository(database);
    await repository.create(id, input(), "2026-07-22T10:00:00.000Z");

    const [first, second] = await Promise.all([
      repository.update(id, { first_name: "First" }, "2026-07-22T11:00:00.001Z"),
      repository.update(id, { first_name: "Second" }, "2026-07-22T11:00:00.002Z"),
    ]);

    expect(first).toMatchObject({
      first_name: "First",
      updated_at: "2026-07-22T11:00:00.001Z",
    });
    expect(second).toMatchObject({
      first_name: "Second",
      updated_at: "2026-07-22T11:00:00.002Z",
    });

    const final = await repository.get(id);
    expect([
      ["First", "2026-07-22T11:00:00.001Z"],
      ["Second", "2026-07-22T11:00:00.002Z"],
    ]).toContainEqual([final?.first_name, final?.updated_at]);
  });

  it("does not resurrect a row across create/delete or PATCH/delete races", async () => {
    const createDeleteId = profileId();
    const repository = new D1ProfileRepository(database);
    const createDelete = await Promise.all([
      repository.create(createDeleteId, input(), "2026-07-22T10:00:00.000Z"),
      repository.delete(createDeleteId),
    ]);
    const [, deletedDuringCreate] = createDelete;
    const afterCreateDelete = await repository.get(createDeleteId);
    expect(afterCreateDelete === undefined).toBe(deletedDuringCreate);

    const patchDeleteId = profileId();
    await repository.create(patchDeleteId, input(), "2026-07-22T10:00:00.000Z");
    const [patched, deletedDuringPatch] = await Promise.all([
      repository.update(patchDeleteId, { first_name: "Grace" }, "2026-07-22T11:00:00.000Z"),
      repository.delete(patchDeleteId),
    ]);
    expect(deletedDuringPatch).toBe(true);
    expect(patched === undefined || patched.first_name === "Grace").toBe(true);
    await expect(repository.get(patchDeleteId)).resolves.toBeUndefined();
  });

  it("reports bounded real D1 metadata for each repository operation", async () => {
    const id = profileId();
    const observed: Array<{ durationMs: number; rowsRead: number; rowsWritten: number }> = [];
    const repository = new D1ProfileRepository(database, {
      onMetadata: (metadata) => observed.push(metadata),
    });

    await repository.create(id, input(), "2026-07-22T10:00:00.000Z");
    await repository.get(id);
    await repository.update(id, { marketing: true }, "2026-07-22T11:00:00.000Z");
    await repository.delete(id);

    expect(observed).toHaveLength(4);
    for (const metadata of observed) {
      expect(metadata.durationMs).toBeGreaterThanOrEqual(0);
      expect(metadata.rowsRead).toBeGreaterThanOrEqual(0);
      expect(metadata.rowsWritten).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(metadata.durationMs)).toBe(true);
    }
    expect(observed[0]?.rowsWritten).toBeGreaterThanOrEqual(1);
    expect(observed[1]?.rowsRead).toBeGreaterThanOrEqual(1);
    expect(observed[2]?.rowsWritten).toBeGreaterThanOrEqual(1);
    expect(observed[3]?.rowsWritten).toBeGreaterThanOrEqual(1);
  });

  it("enforces ASCII phone, boolean, and accepted-terms constraints in D1 itself", async () => {
    const insert = (
      id: string,
      phoneNumber: string,
      marketing: number,
      terms: number,
    ): Promise<D1Result<unknown>> =>
      database
        .prepare(
          `INSERT INTO profiles (
            id, first_name, last_name, email, phone_number, marketing, terms, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          "Ada",
          "Lovelace",
          "ada@example.com",
          phoneNumber,
          marketing,
          terms,
          "2026-07-22T10:00:00.000Z",
          "2026-07-22T10:00:00.000Z",
        )
        .run();

    await expect(insert(profileId(), "+1١٢٣٤٥٦", 0, 1)).rejects.toThrow();
    await expect(insert(profileId(), "+12025550123", 2, 1)).rejects.toThrow();
    await expect(insert(profileId(), "+12025550123", 0, 0)).rejects.toThrow();
  });

  it("maps absent update and delete operations to not found", async () => {
    const id = profileId();
    const service = new ProfileService(
      new D1ProfileRepository(database),
      () => new Date("2026-07-22T10:00:00.000Z"),
    );

    await expect(service.update(id, { marketing: true })).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    await expect(service.delete(id)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  it("turns a corrupt selected row into a safe internal error", async () => {
    const id = profileId();
    await database
      .prepare(
        `INSERT INTO profiles (
        id, first_name, last_name, email, phone_number, marketing, terms, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        "Ada",
        "Lovelace",
        "ADA@EXAMPLE.COM",
        "+358401234567",
        0,
        1,
        "2026-07-22T10:00:00.000Z",
        "2026-07-22T10:00:00.000Z",
      )
      .run();

    const repository = new D1ProfileRepository(database);
    await expect(repository.get(id)).rejects.toBeInstanceOf(ProfileRepositoryError);

    const error = await appError(new ProfileService(repository).get(id));
    expect(error).toMatchObject({
      status: 500,
      code: "internal_error",
      detail: "Internal Server Error",
    });
    expect(error.message).not.toContain("ADA@EXAMPLE.COM");
  });

  it("does not hide non-primary-key constraint failures as conflicts", async () => {
    const id = `${profileId()}-${"x".repeat(128)}`;
    const service = new ProfileService(
      new D1ProfileRepository(database),
      () => new Date("2026-07-22T10:00:00.000Z"),
    );

    const error = await appError(service.create(id, input()));
    expect(error).toMatchObject({
      status: 500,
      code: "internal_error",
      detail: "Internal Server Error",
    });
  });
});
