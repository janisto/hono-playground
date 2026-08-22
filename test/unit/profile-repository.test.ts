import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/core/errors.ts";
import type { Profile, ProfileCreate } from "../../src/models/profile.ts";
import {
  DrizzleProfileRepository,
  isRetryableD1Error,
  type ProfileRepository,
  ProfileRepositoryError,
  ProfileRepositoryUnavailableError,
  TRANSIENT_D1_ERROR_MESSAGES,
} from "../../src/repositories/profile-repository.ts";
import { ProfileService } from "../../src/services/profile-service.ts";

type PreparedCall = { sql: string; bindings: unknown[] };

const databaseHarness = (raw: (call: PreparedCall) => Promise<unknown[][]> = async () => []) => {
  const calls: PreparedCall[] = [];
  const prepare = vi.fn((sql: string): D1PreparedStatement => {
    const call: PreparedCall = { sql, bindings: [] };
    calls.push(call);
    const statement = {
      bind: vi.fn((...bindings: unknown[]) => {
        call.bindings = bindings;
        return statement;
      }),
      raw: vi.fn(() => raw(call)),
    } as unknown as D1PreparedStatement;
    return statement;
  });
  return { database: { prepare } as unknown as D1Database, prepare, calls };
};

const INPUT = {
  firstName: "Ada",
  lastName: "Lovelace",
  contactEmail: "Ada@example.com",
  phoneNumber: "+358401234567",
  marketingOptIn: false,
  termsAccepted: true,
} satisfies ProfileCreate;

const timestamp = Date.parse("2026-07-22T10:00:00.000Z");
const STORED_VALUES = [
  "subject-1",
  INPUT.firstName,
  INPUT.lastName,
  INPUT.contactEmail,
  INPUT.phoneNumber,
  0,
  1,
  timestamp,
  timestamp,
] as const;

const PROFILE = {
  id: "subject-1",
  ...INPUT,
  createdAt: new Date(timestamp),
  updatedAt: new Date(timestamp),
} satisfies Profile;

describe("DrizzleProfileRepository", () => {
  it("uses one conflict-safe create and projects the physical email column", async () => {
    const harness = databaseHarness(async () => [[...STORED_VALUES]]);
    const repository = new DrizzleProfileRepository(harness.database);
    await expect(repository.create("subject-1", INPUT, new Date(timestamp))).resolves.toEqual(PROFILE);
    expect(harness.prepare).toHaveBeenCalledOnce();
    expect(harness.calls[0]?.sql.toLowerCase()).toContain('on conflict ("profiles"."id") do nothing');
    expect(harness.calls[0]?.sql.toLowerCase()).toContain("returning");
    expect(harness.calls[0]?.bindings).toEqual([
      "subject-1",
      "Ada",
      "Lovelace",
      "Ada@example.com",
      "+358401234567",
      0,
      1,
      timestamp,
      timestamp,
    ]);
  });

  it("maps an empty create result to the atomic conflict outcome", async () => {
    const repository = new DrizzleProfileRepository(databaseHarness().database);
    await expect(repository.create("subject-1", INPUT, new Date(timestamp))).resolves.toBeUndefined();
  });

  it("rejects corrupt rows, including a timestamp inversion", async () => {
    const badId = databaseHarness(async () => [["", ...STORED_VALUES.slice(1)]]);
    const inverted = [...STORED_VALUES];
    inverted[7] = timestamp + 1;
    const badTime = databaseHarness(async () => [inverted]);
    await expect(new DrizzleProfileRepository(badId.database).get("subject-1")).rejects.toBeInstanceOf(
      ProfileRepositoryError,
    );
    await expect(new DrizzleProfileRepository(badTime.database).get("subject-1")).rejects.toBeInstanceOf(
      ProfileRepositoryError,
    );
  });

  it("performs a real patch in one atomic UPDATE with monotonic timestamp logic", async () => {
    const updated = [...STORED_VALUES];
    updated[1] = "Grace";
    updated[5] = 1;
    updated[8] = timestamp + 3_600_000;
    const harness = databaseHarness(async () => [updated]);
    const repository = new DrizzleProfileRepository(harness.database);
    await expect(
      repository.update("subject-1", { firstName: "Grace", marketingOptIn: true }, new Date(timestamp + 3_600_000)),
    ).resolves.toMatchObject({ firstName: "Grace", marketingOptIn: true });
    expect(harness.prepare).toHaveBeenCalledOnce();
    const sql = harness.calls[0]?.sql.toLowerCase() ?? "";
    expect(sql).toContain("update");
    expect(sql).toContain("case when");
    expect(sql).toContain('"updated_at" +');
    expect(sql).toContain('"first_name"');
    expect(sql).toContain('"marketing_opt_in"');
    expect(sql).not.toContain('"terms_accepted" =');
    expect(sql).toContain("returning");
  });

  it("returns the unchanged row after a zero-row no-op without retrying", async () => {
    const harness = databaseHarness(async (call) =>
      call.sql.trimStart().toLowerCase().startsWith("update") ? [] : [[...STORED_VALUES]],
    );
    const repository = new DrizzleProfileRepository(harness.database);
    await expect(
      repository.update("subject-1", { firstName: "Ada", marketingOptIn: false }, new Date(timestamp + 1_000)),
    ).resolves.toEqual(PROFILE);
    expect(harness.prepare).toHaveBeenCalledTimes(2);
    expect(harness.calls.map((call) => call.sql.trimStart().split(/\s/u)[0]?.toLowerCase())).toEqual([
      "update",
      "select",
    ]);
  });

  it("fails a real change at the maximum timestamp without dispatch retry", async () => {
    const maximum = Date.parse("9999-12-31T23:59:59.999Z");
    const maximumValues = [...STORED_VALUES];
    maximumValues[8] = maximum;
    const harness = databaseHarness(async (call) =>
      call.sql.trimStart().toLowerCase().startsWith("update") ? [] : [maximumValues],
    );
    const repository = new DrizzleProfileRepository(harness.database);
    await expect(repository.update("subject-1", { firstName: "Grace" }, new Date(maximum))).rejects.toBeInstanceOf(
      ProfileRepositoryError,
    );
    expect(harness.prepare).toHaveBeenCalledTimes(2);
  });

  it("maps an unconfirmed transient failure after one dispatch and never retries", async () => {
    const harness = databaseHarness(async () => {
      throw new Error("D1_ERROR: Network connection lost.");
    });
    const repository = new DrizzleProfileRepository(harness.database);
    await expect(repository.update("subject-1", { firstName: "Grace" }, new Date(timestamp))).rejects.toBeInstanceOf(
      ProfileRepositoryUnavailableError,
    );
    expect(harness.prepare).toHaveBeenCalledOnce();
  });

  it("uses DELETE RETURNING for missing and present rows", async () => {
    await expect(new DrizzleProfileRepository(databaseHarness().database).delete("missing")).resolves.toBe(false);
    const deleted = databaseHarness(async () => [["subject-1"]]);
    await expect(new DrizzleProfileRepository(deleted.database).delete("subject-1")).resolves.toBe(true);
    expect(deleted.calls[0]?.sql.toLowerCase()).toContain("returning");
  });
});

describe("D1 failure classification", () => {
  it.each(TRANSIENT_D1_ERROR_MESSAGES)("accepts only the exact documented transient message: %s", (message) => {
    expect(isRetryableD1Error(new Error(message))).toBe(true);
    expect(isRetryableD1Error(new Error(`D1_ERROR: ${message}`))).toBe(true);
  });

  it("checks bounded causes without substring matching", () => {
    expect(isRetryableD1Error(new Error("query failed", { cause: new Error("Network connection lost.") }))).toBe(true);
    expect(isRetryableD1Error(new Error("prefix Network connection lost."))).toBe(false);
    expect(isRetryableD1Error(new Error("D1_ERROR: no such table: profiles"))).toBe(false);
  });
});

describe("ProfileService", () => {
  const repository = (overrides: Partial<ProfileRepository> = {}): ProfileRepository => ({
    create: async () => PROFILE,
    get: async () => PROFILE,
    update: async () => PROFILE,
    delete: async () => true,
    ...overrides,
  });

  it("maps duplicate and missing lifecycle results to exact portable errors", async () => {
    const service = new ProfileService(
      repository({
        create: async () => undefined,
        get: async () => undefined,
        update: async () => undefined,
        delete: async () => false,
      }),
      () => new Date(timestamp),
    );
    await expect(service.create("subject-1", INPUT)).rejects.toMatchObject({ code: "profile_exists", status: 409 });
    await expect(service.get("subject-1")).rejects.toMatchObject({ code: "profile_not_found", status: 404 });
    await expect(service.update("subject-1", { firstName: "Grace" })).rejects.toMatchObject({
      code: "profile_not_found",
      status: 404,
    });
    await expect(service.delete("subject-1")).rejects.toMatchObject({ code: "profile_not_found", status: 404 });
  });

  it("maps persistence availability without exposing provider detail or fabricating retry metadata", async () => {
    const service = new ProfileService(
      repository({
        get: async () => {
          throw new ProfileRepositoryUnavailableError();
        },
      }),
    );
    let error: unknown;
    try {
      await service.get("subject-1");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: "dependency_unavailable",
      status: 503,
      detail: "A required dependency is unavailable",
    });
    expect((error as AppError).headers.has("Retry-After")).toBe(false);
    expect(JSON.stringify(error)).not.toContain("D1");
  });

  it("normalizes one clock value per mutation and rejects an invalid clock before persistence", async () => {
    const create = vi.fn(async () => PROFILE);
    const update = vi.fn(async () => PROFILE);
    const now = vi.fn(() => new Date(timestamp));
    const service = new ProfileService(repository({ create, update }), now);
    await service.create("subject-1", INPUT);
    await service.update("subject-1", { firstName: "Grace" });
    expect(now).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledWith("subject-1", INPUT, new Date(timestamp));
    expect(update).toHaveBeenCalledWith("subject-1", { firstName: "Grace" }, new Date(timestamp));

    const never = vi.fn(async () => PROFILE);
    const invalid = new ProfileService(repository({ create: never }), () => new Date(Number.NaN));
    await expect(invalid.create("subject-1", INPUT)).rejects.toMatchObject({ code: "internal_error" });
    expect(never).not.toHaveBeenCalled();
  });
});
