import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/core/errors.js";
import type { Profile, ProfileCreate } from "../../src/models/profile.js";
import {
  DrizzleProfileRepository,
  isRetryableD1Error,
  type ProfileRepository,
  ProfileRepositoryError,
  ProfileRepositoryUnavailableError,
  TRANSIENT_D1_ERROR_MESSAGES,
} from "../../src/repositories/profile-repository.js";
import { ProfileService } from "../../src/services/profile-service.js";

type PreparedCall = {
  sql: string;
  bindings: unknown[];
};

type HarnessOptions = {
  raw?: (call: PreparedCall) => Promise<unknown[][]>;
};

const databaseHarness = (options: HarnessOptions = {}) => {
  const calls: PreparedCall[] = [];
  const prepare = vi.fn((sql: string): D1PreparedStatement => {
    const call: PreparedCall = { sql, bindings: [] };
    calls.push(call);
    const statement = {
      bind: vi.fn((...bindings: unknown[]) => {
        call.bindings = bindings;
        return statement;
      }),
      raw: vi.fn(() => options.raw?.(call) ?? Promise.resolve([])),
    } as unknown as D1PreparedStatement;
    return statement;
  });
  return { database: { prepare } as unknown as D1Database, prepare, calls };
};

const INPUT = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  phoneNumber: "+358401234567",
  marketingOptIn: false,
  termsAccepted: true,
} satisfies ProfileCreate;

const STORED_VALUES = [
  "subject-1",
  INPUT.firstName,
  INPUT.lastName,
  INPUT.email,
  INPUT.phoneNumber,
  0,
  1,
  Date.parse("2026-07-22T10:00:00.000Z"),
  Date.parse("2026-07-22T10:00:00.000Z"),
] as const;

const PROFILE = {
  id: "subject-1",
  ...INPUT,
  createdAt: new Date("2026-07-22T10:00:00.000Z"),
  updatedAt: new Date("2026-07-22T10:00:00.000Z"),
} satisfies Profile;

describe("DrizzleProfileRepository", () => {
  it("creates through a typed conflict-safe insert with RETURNING", async () => {
    const harness = databaseHarness({ raw: async () => [[...STORED_VALUES]] });
    const repository = new DrizzleProfileRepository(harness.database);

    await expect(repository.create("subject-1", INPUT, new Date("2026-07-22T10:00:00.000Z"))).resolves.toEqual(PROFILE);

    expect(harness.prepare).toHaveBeenCalledOnce();
    expect(harness.calls[0]?.sql.toLowerCase()).toContain('on conflict ("profiles"."id") do nothing');
    expect(harness.calls[0]?.sql.toLowerCase()).toContain("returning");
    expect(harness.calls[0]?.bindings).toEqual([
      "subject-1",
      "Ada",
      "Lovelace",
      "ada@example.com",
      "+358401234567",
      0,
      1,
      Date.parse("2026-07-22T10:00:00.000Z"),
      Date.parse("2026-07-22T10:00:00.000Z"),
    ]);
  });

  it("reports a primary-key conflict only when RETURNING yields no row", async () => {
    const repository = new DrizzleProfileRepository(databaseHarness().database);
    await expect(repository.create("subject-1", INPUT, new Date("2026-07-22T10:00:00.000Z"))).resolves.toBeUndefined();
  });

  it("rejects corrupt or non-normalized storage rows after Drizzle mapping", async () => {
    const corruptId = databaseHarness({
      raw: async () => [["", ...STORED_VALUES.slice(1)]],
    });
    const nonNormalized = databaseHarness({
      raw: async () => [[...STORED_VALUES.slice(0, 3), "ADA@EXAMPLE.COM", ...STORED_VALUES.slice(4)]],
    });

    await expect(new DrizzleProfileRepository(corruptId.database).get("subject-1")).rejects.toBeInstanceOf(
      ProfileRepositoryError,
    );
    await expect(new DrizzleProfileRepository(nonNormalized.database).get("subject-1")).rejects.toBeInstanceOf(
      ProfileRepositoryError,
    );
  });

  it("turns an empty patch into one typed primary-key read", async () => {
    const harness = databaseHarness({ raw: async () => [[...STORED_VALUES]] });
    const repository = new DrizzleProfileRepository(harness.database);

    await expect(repository.update("subject-1", {}, new Date("2030-01-01T00:00:00.000Z"))).resolves.toEqual(PROFILE);
    expect(harness.prepare).toHaveBeenCalledOnce();
    expect(harness.calls[0]?.sql.toLowerCase()).toContain("select");
    expect(harness.calls[0]?.bindings).toEqual(["subject-1", 2]);
  });

  it("builds PATCH from the typed field allowlist and returns the committed row", async () => {
    const updatedValues = [...STORED_VALUES];
    updatedValues[1] = "Grace";
    updatedValues[5] = 1;
    updatedValues[8] = Date.parse("2026-07-22T11:00:00.000Z");
    const harness = databaseHarness({ raw: async () => [updatedValues] });
    const repository = new DrizzleProfileRepository(harness.database);

    await expect(
      repository.update(
        "subject-1",
        { marketingOptIn: true, firstName: "Grace" },
        new Date("2026-07-22T11:00:00.000Z"),
      ),
    ).resolves.toMatchObject({ firstName: "Grace", marketingOptIn: true });

    const sql = harness.calls[0]?.sql.toLowerCase() ?? "";
    expect(sql).toContain("update");
    expect(sql).toContain('"first_name"');
    expect(sql).toContain('"marketing_opt_in"');
    expect(sql).toContain('"updated_at"');
    expect(sql).not.toContain('"terms_accepted" =');
    expect(sql).toContain("returning");
  });

  it("does not advance updatedAt when every supplied PATCH value is unchanged", async () => {
    const harness = databaseHarness({
      raw: async (call) => (call.sql.trimStart().toLowerCase().startsWith("update") ? [] : [[...STORED_VALUES]]),
    });
    const repository = new DrizzleProfileRepository(harness.database);

    await expect(
      repository.update("subject-1", { firstName: "Ada", marketingOptIn: false }, new Date("2030-01-01T00:00:00.000Z")),
    ).resolves.toEqual(PROFILE);

    expect(harness.prepare).toHaveBeenCalledTimes(2);
    expect(harness.calls[0]?.sql.toLowerCase()).toContain("update");
    expect(harness.calls[0]?.sql.toLowerCase()).toContain('"first_name"');
    expect(harness.calls[0]?.sql.toLowerCase()).toContain('"marketing_opt_in"');
    expect(harness.calls[1]?.sql.toLowerCase()).toContain("select");
  });

  it("retries PATCH at most twice with one timestamp and bounded jitter", async () => {
    let attempts = 0;
    const updatedValues = [...STORED_VALUES];
    updatedValues[1] = "Grace";
    updatedValues[8] = Date.parse("2026-07-22T11:00:00.000Z");
    const harness = databaseHarness({
      raw: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("D1_ERROR: Network connection lost.");
        return [updatedValues];
      },
    });
    const sleep = vi.fn(async () => undefined);
    const repository = new DrizzleProfileRepository(harness.database, {
      sleep,
      random: () => 0,
    });

    await expect(
      repository.update("subject-1", { firstName: "Grace" }, new Date("2026-07-22T11:00:00.000Z")),
    ).resolves.toMatchObject({ firstName: "Grace" });

    expect(harness.prepare).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[25], [50]]);
    for (const call of harness.calls) {
      expect(call.bindings).toContain(Date.parse("2026-07-22T11:00:00.000Z"));
    }
  });

  it("stops PATCH after two retries and maps the transient failure", async () => {
    const harness = databaseHarness({
      raw: async () => {
        throw new Error("Cannot resolve D1 DB due to transient issue on remote node.");
      },
    });
    const repository = new DrizzleProfileRepository(harness.database, {
      sleep: async () => undefined,
      random: () => 1,
    });

    await expect(
      repository.update("subject-1", { firstName: "Grace" }, new Date("2026-07-22T11:00:00.000Z")),
    ).rejects.toBeInstanceOf(ProfileRepositoryUnavailableError);
    expect(harness.prepare).toHaveBeenCalledTimes(3);
  });

  it("does not retry reads, creates, deletes, or unknown PATCH failures", async () => {
    const transient = databaseHarness({
      raw: async () => {
        throw new Error("Network connection lost.");
      },
    });
    const unknown = databaseHarness({
      raw: async () => {
        throw new Error("no such table: profiles");
      },
    });
    const sleep = vi.fn(async () => undefined);

    await expect(new DrizzleProfileRepository(transient.database).get("subject-1")).rejects.toBeInstanceOf(
      ProfileRepositoryUnavailableError,
    );
    await expect(
      new DrizzleProfileRepository(transient.database).create("subject-1", INPUT, new Date("2026-07-22T10:00:00.000Z")),
    ).rejects.toBeInstanceOf(ProfileRepositoryUnavailableError);
    await expect(new DrizzleProfileRepository(transient.database).delete("subject-1")).rejects.toBeInstanceOf(
      ProfileRepositoryUnavailableError,
    );
    await expect(
      new DrizzleProfileRepository(unknown.database, { sleep }).update(
        "subject-1",
        { firstName: "Grace" },
        new Date("2026-07-22T11:00:00.000Z"),
      ),
    ).rejects.toMatchObject({ operatorCode: "profile_repository_failure" });

    expect(transient.prepare).toHaveBeenCalledTimes(3);
    expect(unknown.prepare).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("uses typed DELETE RETURNING for missing and present rows", async () => {
    const missing = new DrizzleProfileRepository(databaseHarness().database);
    const deletedHarness = databaseHarness({ raw: async () => [["subject-1"]] });
    const deleted = new DrizzleProfileRepository(deletedHarness.database);

    await expect(missing.delete("missing")).resolves.toBe(false);
    await expect(deleted.delete("subject-1")).resolves.toBe(true);
    expect(deletedHarness.calls[0]?.sql.toLowerCase()).toContain("returning");
  });
});

describe("D1 transient error classifier", () => {
  it.each(TRANSIENT_D1_ERROR_MESSAGES)("accepts the exact documented message: %s", (message) => {
    expect(isRetryableD1Error(new Error(message))).toBe(true);
    expect(isRetryableD1Error(new Error(`D1_ERROR: ${message}`))).toBe(true);
  });

  it("checks a standard Error cause without broad substring matching", () => {
    expect(isRetryableD1Error(new Error("query failed", { cause: new Error("Network connection lost.") }))).toBe(true);
    expect(isRetryableD1Error(new Error("Network connection lost"))).toBe(false);
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

  it("maps duplicate and missing lifecycle results to stable AppErrors", async () => {
    const service = new ProfileService(
      repository({
        create: async () => undefined,
        get: async () => undefined,
        update: async () => undefined,
        delete: async () => false,
      }),
      () => new Date("2026-07-22T10:00:00.000Z"),
    );

    await expect(service.create("subject-1", INPUT)).rejects.toMatchObject({
      status: 409,
      code: "profile_conflict",
      detail: "Profile already exists",
    });
    await expect(service.get("subject-1")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
      detail: "Profile not found",
    });
    await expect(service.update("subject-1", { firstName: "Grace" })).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    await expect(service.delete("subject-1")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  it("maps repository availability and unknown failures without exposing details", async () => {
    const unavailable = new ProfileService(
      repository({
        get: async () => {
          throw new ProfileRepositoryUnavailableError();
        },
      }),
    );
    const unknown = new ProfileService(
      repository({
        get: async () => {
          throw new Error("SQL and private bind value");
        },
      }),
    );

    await expect(unavailable.get("subject-1")).rejects.toMatchObject({
      status: 503,
      code: "database_unavailable",
      detail: "Database temporarily unavailable",
    });
    await expect(unknown.get("subject-1")).rejects.toMatchObject({
      status: 500,
      code: "internal_error",
      detail: "Internal Server Error",
    });
  });

  it("advertises short retries only for safe read and idempotent PATCH failures", async () => {
    const unavailable = (): never => {
      throw new ProfileRepositoryUnavailableError();
    };
    const service = new ProfileService(
      repository({
        create: async () => unavailable(),
        get: async () => unavailable(),
        update: async () => unavailable(),
        delete: async () => unavailable(),
      }),
      () => new Date("2026-07-22T10:00:00.000Z"),
    );

    const capture = async (operation: Promise<unknown>): Promise<AppError> => {
      try {
        await operation;
      } catch (error) {
        if (error instanceof AppError) return error;
        throw error;
      }
      throw new Error("Expected an AppError");
    };

    const create = await capture(service.create("subject-1", INPUT));
    const get = await capture(service.get("subject-1"));
    const update = await capture(service.update("subject-1", { firstName: "Grace" }));
    const remove = await capture(service.delete("subject-1"));

    expect(create.headers.has("Retry-After")).toBe(false);
    expect(get.headers.get("Retry-After")).toBe("1");
    expect(update.headers.get("Retry-After")).toBe("1");
    expect(remove.headers.has("Retry-After")).toBe(false);
  });

  it("does not consult the clock or call update for an empty patch", async () => {
    const get = vi.fn(async () => PROFILE);
    const update = vi.fn(async () => PROFILE);
    const service = new ProfileService(repository({ get, update }), () => {
      throw new Error("clock must not be read");
    });

    await expect(service.update("subject-1", {})).resolves.toEqual(PROFILE);
    expect(get).toHaveBeenCalledWith("subject-1");
    expect(update).not.toHaveBeenCalled();
  });

  it("uses one precomputed Date per mutation", async () => {
    const create = vi.fn(async () => PROFILE);
    const update = vi.fn(async () => PROFILE);
    const now = vi.fn(() => new Date("2026-07-22T10:00:00.000Z"));
    const service = new ProfileService(repository({ create, update }), now);

    await service.create("subject-1", INPUT);
    await service.update("subject-1", { firstName: "Grace" });

    expect(now).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledWith("subject-1", INPUT, new Date("2026-07-22T10:00:00.000Z"));
    expect(update).toHaveBeenCalledWith("subject-1", { firstName: "Grace" }, new Date("2026-07-22T10:00:00.000Z"));
  });

  it("preserves an AppError raised before a repository call", async () => {
    const service = new ProfileService(repository(), () => {
      throw new AppError({ status: 500, code: "internal_error", detail: "Internal Server Error" });
    });

    await expect(service.create("subject-1", INPUT)).rejects.toBeInstanceOf(AppError);
  });
});
