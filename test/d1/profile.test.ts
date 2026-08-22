import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import { AppError } from "../../src/core/errors.ts";
import { type ProfileCreate, ProfileCreateSchema } from "../../src/models/profile.ts";
import { DrizzleProfileRepository, ProfileRepositoryError } from "../../src/repositories/profile-repository.ts";
import { ProfileService } from "../../src/services/profile-service.ts";

const database = (env as unknown as { readonly DB: D1Database }).DB;
const trackedIds = new Set<string>();

const profileId = (): string => {
  const id = `profile-test-${crypto.randomUUID()}`;
  trackedIds.add(id);
  return id;
};

const input = (overrides: Partial<ProfileCreate> = {}): ProfileCreate =>
  ProfileCreateSchema.parse({
    firstName: "Ada",
    lastName: "Lovelace",
    contactEmail: "ADA@example.com ",
    phoneNumber: " +358401234567 ",
    termsAccepted: true,
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
  await database.batch(ids.map((id) => database.prepare("DELETE FROM profiles WHERE id = ?").bind(id)));
});

describe("D1 profile lifecycle", () => {
  it("creates, reads, patches, preserves timestamps on no-ops, and deletes", async () => {
    const id = profileId();
    const timestamps = [
      new Date("2026-07-22T10:00:00.000Z"),
      new Date("2026-07-22T11:00:00.000Z"),
      new Date("2026-07-22T12:00:00.000Z"),
    ];
    const repository = new DrizzleProfileRepository(database);
    const service = new ProfileService(repository, () => {
      const timestamp = timestamps.shift();
      if (timestamp === undefined) throw new Error("unexpected clock read");
      return timestamp;
    });

    const created = await service.create(id, input());
    expect(created).toEqual({
      id,
      firstName: "Ada",
      lastName: "Lovelace",
      contactEmail: "ADA@example.com",
      phoneNumber: "+358401234567",
      marketingOptIn: false,
      termsAccepted: true,
      createdAt: new Date("2026-07-22T10:00:00.000Z"),
      updatedAt: new Date("2026-07-22T10:00:00.000Z"),
    });
    await expect(service.get(id)).resolves.toEqual(created);

    const updated = await service.update(id, { firstName: "Grace", marketingOptIn: true });
    expect(updated).toMatchObject({
      id,
      firstName: "Grace",
      marketingOptIn: true,
      createdAt: created.createdAt,
      updatedAt: new Date("2026-07-22T11:00:00.000Z"),
    });
    await expect(service.update(id, { firstName: "Grace", marketingOptIn: true })).resolves.toEqual(updated);
    expect(timestamps).toHaveLength(0);

    await expect(service.delete(id)).resolves.toBeUndefined();
    const missing = await appError(service.get(id));
    expect(missing).toMatchObject({
      status: 404,
      code: "profile_not_found",
      detail: "Profile not found",
    });
    await expect(service.delete(id)).rejects.toMatchObject({ status: 404, code: "profile_not_found" });
  });

  it("serializes concurrent creates into one success, one conflict, and one stored row", async () => {
    const id = profileId();
    const service = new ProfileService(
      new DrizzleProfileRepository(database),
      () => new Date("2026-07-22T10:00:00.000Z"),
    );

    const outcomes = await Promise.allSettled([
      service.create(id, input({ firstName: "Ada" })),
      service.create(id, input({ firstName: "Grace" })),
    ]);
    const successes = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const failures = outcomes.filter((outcome) => outcome.status === "rejected");

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toBeInstanceOf(AppError);
    expect(failures[0]?.reason).toMatchObject({ status: 409, code: "profile_exists" });

    const count = await database
      .prepare("SELECT COUNT(*) AS count FROM profiles WHERE id = ?")
      .bind(id)
      .first<number>("count");
    expect(count).toBe(1);
    await expect(service.get(id)).resolves.toMatchObject({
      id,
      firstName: expect.stringMatching(/^(Ada|Grace)$/),
    });
  });

  it("keeps concurrent PATCH behavior last-commit-wins with internally consistent snapshots", async () => {
    const id = profileId();
    const repository = new DrizzleProfileRepository(database);
    await repository.create(id, input(), new Date("2026-07-22T10:00:00.000Z"));

    const [first, second] = await Promise.all([
      repository.update(id, { firstName: "First" }, new Date("2026-07-22T11:00:00.001Z")),
      repository.update(id, { firstName: "Second" }, new Date("2026-07-22T11:00:00.002Z")),
    ]);

    expect(first).toMatchObject({
      firstName: "First",
      updatedAt: new Date("2026-07-22T11:00:00.001Z"),
    });
    expect(second).toMatchObject({
      firstName: "Second",
      updatedAt: new Date("2026-07-22T11:00:00.002Z"),
    });

    const final = await repository.get(id);
    expect([
      ["First", new Date("2026-07-22T11:00:00.001Z")],
      ["Second", new Date("2026-07-22T11:00:00.002Z")],
    ]).toContainEqual([final?.firstName, final?.updatedAt]);
  });

  it("does not resurrect a row across create/delete or PATCH/delete races", async () => {
    const createDeleteId = profileId();
    const repository = new DrizzleProfileRepository(database);
    const createDelete = await Promise.all([
      repository.create(createDeleteId, input(), new Date("2026-07-22T10:00:00.000Z")),
      repository.delete(createDeleteId),
    ]);
    const [, deletedDuringCreate] = createDelete;
    const afterCreateDelete = await repository.get(createDeleteId);
    expect(afterCreateDelete === undefined).toBe(deletedDuringCreate);

    const patchDeleteId = profileId();
    await repository.create(patchDeleteId, input(), new Date("2026-07-22T10:00:00.000Z"));
    const [patched, deletedDuringPatch] = await Promise.all([
      repository.update(patchDeleteId, { firstName: "Grace" }, new Date("2026-07-22T11:00:00.000Z")),
      repository.delete(patchDeleteId),
    ]);
    expect(deletedDuringPatch).toBe(true);
    expect(patched === undefined || patched.firstName === "Grace").toBe(true);
    await expect(repository.get(patchDeleteId)).resolves.toBeUndefined();
  });

  it("serializes concurrent deletes into one deletion and one missing result", async () => {
    const id = profileId();
    const repository = new DrizzleProfileRepository(database);
    await repository.create(id, input(), new Date("2026-07-22T10:00:00.000Z"));

    const outcomes = await Promise.all([repository.delete(id), repository.delete(id)]);

    expect(outcomes.toSorted()).toEqual([false, true]);
    await expect(repository.get(id)).resolves.toBeUndefined();
  });

  it("enforces ASCII phone, boolean, and accepted-terms constraints in D1 itself", async () => {
    const insert = (
      id: string | null,
      phoneNumber: string,
      marketingOptIn: number,
      termsAccepted: number,
    ): Promise<D1Result<unknown>> =>
      database
        .prepare(
          `INSERT INTO profiles (
            id, first_name, last_name, email, phone_number, marketing_opt_in,
            terms_accepted, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          "Ada",
          "Lovelace",
          "ada@example.com",
          phoneNumber,
          marketingOptIn,
          termsAccepted,
          Date.parse("2026-07-22T10:00:00.000Z"),
          Date.parse("2026-07-22T10:00:00.000Z"),
        )
        .run();

    await expect(insert(null, "+12025550123", 0, 1)).rejects.toThrow();
    await expect(insert(profileId(), "+1١٢٣٤٥٦", 0, 1)).rejects.toThrow();
    await expect(insert(profileId(), "+12025550123", 2, 1)).rejects.toThrow();
    await expect(insert(profileId(), "+12025550123", 0, 0)).rejects.toThrow();
  });

  it("maps absent update and delete operations to not found", async () => {
    const id = profileId();
    const service = new ProfileService(
      new DrizzleProfileRepository(database),
      () => new Date("2026-07-22T10:00:00.000Z"),
    );

    await expect(service.update(id, { marketingOptIn: true })).rejects.toMatchObject({
      status: 404,
      code: "profile_not_found",
    });
    await expect(service.delete(id)).rejects.toMatchObject({
      status: 404,
      code: "profile_not_found",
    });
  });

  it("turns a corrupt selected row into a safe internal error", async () => {
    const id = profileId();
    await database
      .prepare(
        `INSERT INTO profiles (
        id, first_name, last_name, email, phone_number, marketing_opt_in,
        terms_accepted, created_at, updated_at
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
        Date.parse("2026-07-22T10:00:00.000Z"),
        Date.parse("2026-07-22T10:00:00.000Z"),
      )
      .run();

    const repository = new DrizzleProfileRepository(database);
    await expect(repository.get(id)).rejects.toBeInstanceOf(ProfileRepositoryError);

    const error = await appError(new ProfileService(repository).get(id));
    expect(error).toMatchObject({
      status: 500,
      code: "internal_error",
      detail: "Internal server error",
    });
    expect(error.message).not.toContain("ADA@EXAMPLE.COM");
  });

  it("does not hide non-primary-key constraint failures as conflicts", async () => {
    const id = `${profileId()}-${"x".repeat(128)}`;
    const service = new ProfileService(
      new DrizzleProfileRepository(database),
      () => new Date("2026-07-22T10:00:00.000Z"),
    );

    const error = await appError(service.create(id, input()));
    expect(error).toMatchObject({
      status: 500,
      code: "internal_error",
      detail: "Internal server error",
    });
  });
});
