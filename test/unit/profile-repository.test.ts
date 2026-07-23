import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/core/errors.js";
import type { Profile, ProfileCreate } from "../../src/models/profile.js";
import {
  D1ProfileRepository,
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
  batch?: (calls: readonly PreparedCall[]) => Promise<D1Result<unknown>[]>;
  run?: (call: PreparedCall) => Promise<D1Result<unknown>>;
};

type FakeStatement = D1PreparedStatement & { readonly call: PreparedCall };

const result = (
  results: unknown[],
  changes = 0,
  metadata: Partial<D1Meta> = {},
): D1Result<unknown> => ({
  success: true,
  results,
  meta: {
    duration: 1,
    size_after: 0,
    rows_read: results.length,
    rows_written: changes,
    last_row_id: 0,
    changed_db: changes > 0,
    changes,
    ...metadata,
  },
});

const databaseHarness = (options: HarnessOptions = {}) => {
  const calls: PreparedCall[] = [];

  const prepare = vi.fn((sql: string): D1PreparedStatement => {
    const call: PreparedCall = { sql, bindings: [] };
    calls.push(call);

    const statement = {
      call,
      bind: vi.fn((...bindings: unknown[]) => {
        call.bindings = bindings;
        return statement;
      }),
      run: vi.fn(() => options.run?.(call) ?? Promise.resolve(result([]))),
    } as unknown as FakeStatement;

    return statement;
  });

  const batch = vi.fn((statements: D1PreparedStatement[]) => {
    const batchCalls = statements.map((statement) => (statement as FakeStatement).call);
    return options.batch?.(batchCalls) ?? Promise.resolve([]);
  });

  const database = { prepare, batch } as unknown as D1Database;
  return { database, prepare, batch, calls };
};

const INPUT = {
  first_name: "Ada",
  last_name: "Lovelace",
  email: "ada@example.com",
  phone_number: "+358401234567",
  marketing: false,
  terms: true,
} satisfies ProfileCreate;

const STORED_PROFILE = {
  id: "subject-1",
  first_name: INPUT.first_name,
  last_name: INPUT.last_name,
  email: INPUT.email,
  phone_number: INPUT.phone_number,
  marketing: 0,
  terms: 1,
  created_at: "2026-07-22T10:00:00.000Z",
  updated_at: "2026-07-22T10:00:00.000Z",
} as const;

const PROFILE = {
  ...STORED_PROFILE,
  marketing: false,
  terms: true,
} satisfies Profile;

describe("D1ProfileRepository", () => {
  it("creates with positional binds, a conflict-specific insert, and one batch", async () => {
    const metadata = vi.fn();
    const harness = databaseHarness({
      batch: async () => [
        result([], 1, { duration: 2, rows_written: 1 }),
        result([STORED_PROFILE], 0, { duration: 3, rows_read: 1 }),
      ],
    });
    const repository = new D1ProfileRepository(harness.database, {
      onMetadata: metadata,
    });

    await expect(
      repository.create("subject-1", INPUT, "2026-07-22T10:00:00.000Z"),
    ).resolves.toEqual(PROFILE);

    expect(harness.batch).toHaveBeenCalledOnce();
    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[0]?.sql).toContain("ON CONFLICT(id) DO NOTHING");
    expect(harness.calls[0]?.sql).not.toContain("INSERT OR IGNORE");
    expect(harness.calls[0]?.bindings).toEqual([
      "subject-1",
      "Ada",
      "Lovelace",
      "ada@example.com",
      "+358401234567",
      0,
      1,
      "2026-07-22T10:00:00.000Z",
      "2026-07-22T10:00:00.000Z",
    ]);
    expect(harness.calls[1]).toMatchObject({
      sql: expect.stringContaining("WHERE id = ?"),
      bindings: ["subject-1"],
    });
    expect(metadata).toHaveBeenCalledOnce();
    expect(metadata).toHaveBeenCalledWith({ durationMs: 5, rowsRead: 1, rowsWritten: 1 });
  });

  it("reports a primary-key conflict only when the insert changed no row", async () => {
    const harness = databaseHarness({
      batch: async () => [result([], 0), result([STORED_PROFILE])],
    });
    const repository = new D1ProfileRepository(harness.database);

    await expect(
      repository.create("subject-1", INPUT, "2026-07-22T10:00:00.000Z"),
    ).resolves.toBeUndefined();
  });

  it("uses a primary-key read and rejects corrupt storage rows", async () => {
    const harness = databaseHarness({
      run: async () => result([{ ...STORED_PROFILE, marketing: 2 }]),
    });
    const repository = new D1ProfileRepository(harness.database);

    await expect(repository.get("subject-1")).rejects.toBeInstanceOf(ProfileRepositoryError);
    expect(harness.calls[0]).toMatchObject({
      sql: expect.stringContaining("WHERE id = ?"),
      bindings: ["subject-1"],
    });
  });

  it("rejects stored values that request schemas would silently normalize", async () => {
    const harness = databaseHarness({
      run: async () => result([{ ...STORED_PROFILE, email: "ADA@EXAMPLE.COM" }]),
    });
    const repository = new D1ProfileRepository(harness.database);

    await expect(repository.get("subject-1")).rejects.toBeInstanceOf(ProfileRepositoryError);
  });

  it("turns an empty patch into a single read without a batch", async () => {
    const harness = databaseHarness({
      run: async () => result([STORED_PROFILE]),
    });
    const repository = new D1ProfileRepository(harness.database);

    await expect(repository.update("subject-1", {}, "2030-01-01T00:00:00.000Z")).resolves.toEqual(
      PROFILE,
    );
    expect(harness.batch).not.toHaveBeenCalled();
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.sql).toMatch(/^SELECT /);
  });

  it("builds PATCH SQL from the fixed field allowlist and binds the timestamp once", async () => {
    const updatedRow = {
      ...STORED_PROFILE,
      first_name: "Grace",
      marketing: 1,
      updated_at: "2026-07-22T11:00:00.000Z",
    };
    const harness = databaseHarness({
      batch: async () => [result([], 1), result([updatedRow])],
    });
    const repository = new D1ProfileRepository(harness.database);

    await expect(
      repository.update(
        "subject-1",
        { marketing: true, first_name: "Grace" },
        "2026-07-22T11:00:00.000Z",
      ),
    ).resolves.toMatchObject({ first_name: "Grace", marketing: true });

    expect(harness.calls[0]).toEqual({
      sql: "UPDATE profiles SET first_name = ?, marketing = ?, updated_at = ? WHERE id = ?",
      bindings: ["Grace", 1, "2026-07-22T11:00:00.000Z", "subject-1"],
    });
    expect(harness.calls[1]?.bindings).toEqual(["subject-1"]);
  });

  it("retries PATCH at most twice with fixed SQL, values, timestamp, and bounded jitter", async () => {
    let attempts = 0;
    const updatedRow = {
      ...STORED_PROFILE,
      first_name: "Grace",
      updated_at: "2026-07-22T11:00:00.000Z",
    };
    const harness = databaseHarness({
      batch: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("D1_ERROR: Network connection lost.");
        return [result([], 1), result([updatedRow])];
      },
    });
    const sleep = vi.fn(async () => undefined);
    const repository = new D1ProfileRepository(harness.database, {
      sleep,
      random: () => 0,
    });

    await expect(
      repository.update("subject-1", { first_name: "Grace" }, "2026-07-22T11:00:00.000Z"),
    ).resolves.toMatchObject({ first_name: "Grace" });

    expect(harness.batch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[25], [50]]);
    expect(harness.calls.filter((_, index) => index % 2 === 0)).toEqual([
      {
        sql: "UPDATE profiles SET first_name = ?, updated_at = ? WHERE id = ?",
        bindings: ["Grace", "2026-07-22T11:00:00.000Z", "subject-1"],
      },
      {
        sql: "UPDATE profiles SET first_name = ?, updated_at = ? WHERE id = ?",
        bindings: ["Grace", "2026-07-22T11:00:00.000Z", "subject-1"],
      },
      {
        sql: "UPDATE profiles SET first_name = ?, updated_at = ? WHERE id = ?",
        bindings: ["Grace", "2026-07-22T11:00:00.000Z", "subject-1"],
      },
    ]);
  });

  it("stops PATCH after two retries and maps the transient failure", async () => {
    const harness = databaseHarness({
      batch: async () => {
        throw new Error("Cannot resolve D1 DB due to transient issue on remote node.");
      },
    });
    const repository = new D1ProfileRepository(harness.database, {
      sleep: async () => undefined,
      random: () => 1,
    });

    await expect(
      repository.update("subject-1", { first_name: "Grace" }, "2026-07-22T11:00:00.000Z"),
    ).rejects.toBeInstanceOf(ProfileRepositoryUnavailableError);
    expect(harness.batch).toHaveBeenCalledTimes(3);
  });

  it("leaves transient read retry ownership to D1 and maps one failed run", async () => {
    const harness = databaseHarness({
      run: async () => {
        throw new Error("Network connection lost.");
      },
    });
    const repository = new D1ProfileRepository(harness.database);

    await expect(repository.get("subject-1")).rejects.toBeInstanceOf(
      ProfileRepositoryUnavailableError,
    );
    expect(harness.calls).toHaveLength(1);
  });

  it("does not retry unknown PATCH failures", async () => {
    const harness = databaseHarness({
      batch: async () => {
        throw new Error("no such table: profiles");
      },
    });
    const sleep = vi.fn(async () => undefined);
    const repository = new D1ProfileRepository(harness.database, { sleep });

    await expect(
      repository.update("subject-1", { first_name: "Grace" }, "2026-07-22T11:00:00.000Z"),
    ).rejects.toMatchObject({ operatorCode: "profile_repository_failure" });
    expect(harness.batch).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("never retries create or delete after an ambiguous transient failure", async () => {
    const createHarness = databaseHarness({
      batch: async () => {
        throw new Error("Network connection lost.");
      },
    });
    const deleteHarness = databaseHarness({
      run: async () => {
        throw new Error("D1 DB reset because its code was updated.");
      },
    });

    await expect(
      new D1ProfileRepository(createHarness.database).create(
        "subject-1",
        INPUT,
        "2026-07-22T10:00:00.000Z",
      ),
    ).rejects.toBeInstanceOf(ProfileRepositoryUnavailableError);
    await expect(
      new D1ProfileRepository(deleteHarness.database).delete("subject-1"),
    ).rejects.toBeInstanceOf(ProfileRepositoryUnavailableError);
    expect(createHarness.batch).toHaveBeenCalledOnce();
    expect(deleteHarness.calls[0]?.bindings).toEqual(["subject-1"]);
  });

  it("uses delete changes metadata for the lifecycle result", async () => {
    const missingHarness = databaseHarness({ run: async () => result([], 0) });
    const deletedHarness = databaseHarness({ run: async () => result([], 1) });

    await expect(new D1ProfileRepository(missingHarness.database).delete("missing")).resolves.toBe(
      false,
    );
    await expect(
      new D1ProfileRepository(deletedHarness.database).delete("subject-1"),
    ).resolves.toBe(true);
  });

  it("does not allow a metadata observer failure to change a committed result", async () => {
    const harness = databaseHarness({
      batch: async () => [result([], 1), result([STORED_PROFILE])],
    });
    const repository = new D1ProfileRepository(harness.database, {
      onMetadata: () => {
        throw new Error("observer failed");
      },
    });

    await expect(
      repository.create("subject-1", INPUT, "2026-07-22T10:00:00.000Z"),
    ).resolves.toEqual(PROFILE);
  });
});

describe("D1 transient error classifier", () => {
  it.each(TRANSIENT_D1_ERROR_MESSAGES)("accepts the exact documented message: %s", (message) => {
    expect(isRetryableD1Error(new Error(message))).toBe(true);
    expect(isRetryableD1Error(new Error(`D1_ERROR: ${message}`))).toBe(true);
  });

  it("checks a standard Error cause without broad substring matching", () => {
    expect(
      isRetryableD1Error(
        new Error("query failed", { cause: new Error("Network connection lost.") }),
      ),
    ).toBe(true);
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
    await expect(service.update("subject-1", { first_name: "Grace" })).rejects.toMatchObject({
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
    const update = await capture(service.update("subject-1", { first_name: "Grace" }));
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

  it("uses one precomputed ISO timestamp per mutation", async () => {
    const create = vi.fn(async () => PROFILE);
    const update = vi.fn(async () => PROFILE);
    const now = vi.fn(() => new Date("2026-07-22T10:00:00.000Z"));
    const service = new ProfileService(repository({ create, update }), now);

    await service.create("subject-1", INPUT);
    await service.update("subject-1", { first_name: "Grace" });

    expect(now).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledWith("subject-1", INPUT, "2026-07-22T10:00:00.000Z");
    expect(update).toHaveBeenCalledWith(
      "subject-1",
      { first_name: "Grace" },
      "2026-07-22T10:00:00.000Z",
    );
  });

  it("preserves an AppError raised before a repository call", async () => {
    const service = new ProfileService(repository(), () => {
      throw new AppError({ status: 500, code: "internal_error", detail: "Internal Server Error" });
    });

    await expect(service.create("subject-1", INPUT)).rejects.toBeInstanceOf(AppError);
  });
});
