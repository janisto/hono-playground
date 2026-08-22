import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.ts";
import type { RuntimeBindings } from "../../src/core/types.ts";
import { encodeCursor } from "../../src/pagination/cursor.ts";

const ORIGIN = "https://api.example.test";
const TEST_BINDINGS = {
  DB: {} as D1Database,
  ENVIRONMENT: "test",
  RATE_LIMIT_MODE: "none",
} satisfies RuntimeBindings;
const RATE_LIMIT_KEY = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

const OWNER = {
  login: "octocat",
  id: 1,
  avatar_url: "https://avatars.githubusercontent.com/u/1",
  html_url: "https://github.com/octocat",
  type: "User",
  name: "The Octocat",
  company: null,
  blog: "",
  location: "San Francisco",
  bio: "A cat",
  public_repos: 8,
  followers: 1_000,
  following: 0,
  created_at: "2011-01-25T18:44:36.000Z",
  updated_at: "2024-01-01T00:00:00.000Z",
} as const;
const SUMMARY = {
  id: 2,
  name: "repo",
  full_name: "octocat/repo",
  description: null,
  html_url: "https://github.com/octocat/repo",
  fork: false,
  private: false,
  visibility: "public",
} as const;
const DETAIL = {
  ...SUMMARY,
  language: "TypeScript",
  stargazers_count: 4,
  forks_count: 3,
  open_issues_count: 2,
  archived: false,
  created_at: "2024-01-01T00:00:00.000Z",
  updated_at: "2024-01-02T00:00:00.000Z",
  pushed_at: null,
  default_branch: "main",
  license: { spdx_id: "MIT" },
  topics: ["z", "A", "a"],
  disabled: false,
} as const;
const ACTIVITY = {
  id: 3,
  actor: { login: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/1" },
  ref: "refs/heads/main",
  timestamp: "2024-01-03T00:00:00.000Z",
  activity_type: "push",
} as const;
const TAG = { name: "v1.0.0", commit: { sha: "a".repeat(40) } } as const;

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Problem = {
  type: "about:blank";
  title: string;
  status: number;
  detail: string;
  code: string;
  errors?: unknown[];
};

const injectedFetch = (implementation: FetchImplementation): typeof globalThis.fetch =>
  vi.fn(implementation) as unknown as typeof globalThis.fetch;

const jsonResponse = (value: unknown, status = 200, headers: HeadersInit = {}): Response => {
  const responseHeaders = new Headers({ "Content-Type": "application/json" });
  new Headers(headers).forEach((headerValue, name) => {
    responseHeaders.set(name, headerValue);
  });
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
};

const sequenceFetch = (...responses: Response[]): typeof globalThis.fetch => {
  const queue = [...responses];
  return injectedFetch(async () => {
    const response = queue.shift();
    if (response === undefined) throw new Error("Unexpected fetch");
    return response;
  });
};

const request = (
  fetch: typeof globalThis.fetch,
  path: string,
  init: RequestInit = {},
  bindings: RuntimeBindings = TEST_BINDINGS,
  accessVerifier = vi.fn(async () => ({ sub: "must-not-run" })),
): Promise<Response> => {
  const app = createApp({ githubClientOptions: { fetch }, accessVerifier });
  return Promise.resolve(app.request(new Request(`${ORIGIN}${path}`, init), undefined, bindings));
};

const problem = async (response: Response, status: number, code: string): Promise<Problem> => {
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toBe("application/problem+json");
  const body = (await response.json()) as Problem;
  expect(body).toMatchObject({ type: "about:blank", status, code });
  return body;
};

const linkTarget = (header: string | null, relation: "next" | "prev"): string => {
  const value = (header ?? "").split(", ").find((candidate) => candidate.endsWith(`rel="${relation}"`));
  const target = /^<([^>]*)>/u.exec(value ?? "")?.[1];
  if (target === undefined) throw new TypeError(`Missing ${relation} link`);
  return target;
};

const commonHeaders = (response: Response): void => {
  expect(response.headers.get("X-Request-ID")).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  expect(response.headers.get("Vary")?.split(", ").sort()).toEqual(["Accept"]);
};

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("GitHub route inventory and success projection", () => {
  it("serves all six exact public operations through the real Hono boundary", async () => {
    const fetch = injectedFetch(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/users/octocat") return jsonResponse(OWNER);
      if (url.pathname === "/users/octocat/repos") return jsonResponse([SUMMARY]);
      if (url.pathname === "/repos/octocat/repo") return jsonResponse(DETAIL);
      if (url.pathname.endsWith("/activity")) return jsonResponse([ACTIVITY, { ...ACTIVITY, id: 4, actor: null }]);
      if (url.pathname.endsWith("/languages")) return jsonResponse({ "\u{10000}": 5, "\uE000": 5, TypeScript: 10 });
      if (url.pathname.endsWith("/tags")) return jsonResponse([TAG]);
      throw new Error(`Unexpected path ${url.pathname}`);
    });

    const owner = await request(fetch, "/v1/github/owners/octocat");
    expect(owner.status).toBe(200);
    expect(owner.headers.get("Content-Type")).toBe("application/json");
    expect(await owner.json()).toEqual({
      id: 1,
      login: "octocat",
      type: "User",
      name: "The Octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/1",
      htmlUrl: "https://github.com/octocat",
      company: null,
      blog: null,
      location: "San Francisco",
      bio: "A cat",
      publicRepos: 8,
      followers: 1_000,
      following: 0,
      createdAt: "2011-01-25T18:44:36.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });

    const repos = await request(fetch, "/v1/github/owners/octocat/repos");
    expect(await repos.json()).toEqual({
      repos: [
        {
          id: 2,
          name: "repo",
          fullName: "octocat/repo",
          description: null,
          htmlUrl: "https://github.com/octocat/repo",
          fork: false,
        },
      ],
      count: 1,
    });

    const repository = await request(fetch, "/v1/github/repos/octocat/repo");
    expect(await repository.json()).toEqual({
      id: 2,
      name: "repo",
      fullName: "octocat/repo",
      description: null,
      htmlUrl: "https://github.com/octocat/repo",
      fork: false,
      language: "TypeScript",
      stargazersCount: 4,
      forksCount: 3,
      openIssuesCount: 2,
      archived: false,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
      pushedAt: null,
      defaultBranch: "main",
      license: "MIT",
      topics: ["A", "a", "z"],
      disabled: false,
    });

    const activity = await request(fetch, "/v1/github/repos/octocat/repo/activity");
    expect(await activity.json()).toEqual({
      activities: [
        {
          id: 3,
          actor: "octocat",
          actorAvatarUrl: "https://avatars.githubusercontent.com/u/1",
          ref: "refs/heads/main",
          timestamp: "2024-01-03T00:00:00.000Z",
          activityType: "push",
        },
        {
          id: 4,
          actor: null,
          actorAvatarUrl: null,
          ref: "refs/heads/main",
          timestamp: "2024-01-03T00:00:00.000Z",
          activityType: "push",
        },
      ],
      count: 2,
    });

    const languages = await request(fetch, "/v1/github/repos/octocat/repo/languages");
    expect(await languages.json()).toEqual({
      languages: [
        { name: "TypeScript", bytes: 10 },
        { name: "\uE000", bytes: 5 },
        { name: "\u{10000}", bytes: 5 },
      ],
    });

    const tags = await request(fetch, "/v1/github/repos/octocat/repo/tags");
    expect(await tags.json()).toEqual({ tags: [TAG], count: 1 });

    for (const response of [owner, repos, repository, activity, languages, tags]) commonHeaders(response);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("does not invoke Access or forward caller and ambient credentials", async () => {
    const fetch = injectedFetch(async () => jsonResponse(OWNER));
    const accessVerifier = vi.fn(async () => ({ sub: "must-not-run" }));
    const app = createApp({ githubClientOptions: { fetch }, accessVerifier });
    const response = await app.request(
      new Request(`${ORIGIN}/v1/github/owners/octocat`, {
        headers: {
          Authorization: "Bearer inbound-secret",
          Cookie: "CF_Authorization=session-secret",
          "Cf-Access-Jwt-Assertion": "access-secret",
          Baggage: "trace-secret",
          Forwarded: "for=private",
          "User-Agent": "caller-agent",
          "X-Request-ID": "caller-request",
        },
      }),
      undefined,
      TEST_BINDINGS,
    );

    expect(response.status).toBe(200);
    expect(accessVerifier).not.toHaveBeenCalled();
    const headers = new Headers(vi.mocked(fetch).mock.calls[0]?.[1]?.headers);
    expect([...headers.entries()]).toEqual([
      ["accept", "application/vnd.github+json"],
      ["accept-encoding", "identity"],
      ["user-agent", "hono-playground"],
      ["x-github-api-version", "2026-03-10"],
    ]);
  });

  it("uses Hono's tested GET-derived HEAD extension truthfully", async () => {
    const fetch = sequenceFetch(jsonResponse(OWNER));
    const response = await request(fetch, "/v1/github/owners/octocat", { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.text()).toBe("");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("GitHub local validation and forbidden side effects", () => {
  it.each([
    ["owner begins with underscore", "/v1/github/owners/_owner", 422],
    ["owner ends with dash", "/v1/github/owners/owner-", 422],
    ["owner too long", `/v1/github/owners/${"a".repeat(40)}`, 422],
    ["repo dot only", "/v1/github/repos/octocat/...", 422],
    ["repo too long", `/v1/github/repos/octocat/${"a".repeat(101)}`, 422],
    ["encoded separator", "/v1/github/owners/octocat%2Frepo", 404],
    ["encoded control", "/v1/github/owners/octocat%00", 404],
    ["Unicode lookalike", "/v1/github/owners/octoc%C3%A4t", 404],
  ])("rejects an invalid path without fetching: %s", async (_name, path, status) => {
    const fetch = injectedFetch(async () => jsonResponse(OWNER));
    await problem(await request(fetch, path), status, status === 422 ? "validation_failed" : "not_found");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts the exact owner and repository path boundaries", async () => {
    const fetch = sequenceFetch(jsonResponse(OWNER), jsonResponse(OWNER), jsonResponse(DETAIL), jsonResponse(DETAIL));
    const ownerOne = await request(fetch, "/v1/github/owners/a");
    const ownerThirtyNine = await request(fetch, `/v1/github/owners/a_${"b".repeat(36)}c`);
    const repoOne = await request(fetch, "/v1/github/repos/a/r");
    const repoHundred = await request(fetch, `/v1/github/repos/a/${`r${".".repeat(99)}`}`);

    expect([ownerOne.status, ownerThirtyNine.status, repoOne.status, repoHundred.status]).toEqual([200, 200, 200, 200]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["query on point read", "/v1/github/owners/octocat?limit=1"],
    ["unknown query", "/v1/github/owners/octocat/repos?offset=1"],
    ["repeated query", "/v1/github/owners/octocat/repos?limit=1&limit=2"],
    ["malformed escape", "/v1/github/owners/octocat/repos?cursor=%"],
    ["invalid UTF-8", "/v1/github/owners/octocat/repos?cursor=%FF"],
    ["empty cursor", "/v1/github/owners/octocat/repos?cursor="],
    ["non-ASCII cursor", "/v1/github/owners/octocat/repos?cursor=%C3%A4"],
    ["oversized cursor", `/v1/github/owners/octocat/repos?cursor=${"a".repeat(2_049)}`],
  ])("returns 400 before fetch for malformed closed query: %s", async (_name, path) => {
    const fetch = injectedFetch(async () => jsonResponse([]));
    await problem(await request(fetch, path), 400, "invalid_request");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["text", "0", "101", "1.5", "9007199254740992"])(
    "returns 422 before fetch for invalid typed limit %s",
    async (limit) => {
      const fetch = injectedFetch(async () => jsonResponse([]));
      const body = await problem(
        await request(fetch, `/v1/github/owners/octocat/repos?limit=${limit}`),
        422,
        "validation_failed",
      );
      expect(body.errors).toBeDefined();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "1", "100"])("accepts the effective limit boundary %s", async (limit) => {
    const fetch = injectedFetch(async () => jsonResponse([]));
    const suffix = limit === undefined ? "" : `?limit=${limit}`;
    expect((await request(fetch, `/v1/github/owners/octocat/repos${suffix}`)).status).toBe(200);
    const upstream = new URL(String(vi.mocked(fetch).mock.calls[0]?.[0]));
    expect(upstream.searchParams.get("per_page")).toBe(limit ?? "20");
  });

  it.each([
    [
      "cross operation",
      {
        version: 1,
        operation: "listGitHubRepositoryTags",
        direction: "next",
        owner: "octocat",
        repo: null,
        limit: 20,
        page: 2,
      },
    ],
    [
      "wrong owner",
      {
        version: 1,
        operation: "listGitHubOwnerRepositories",
        direction: "next",
        owner: "other",
        repo: null,
        limit: 20,
        page: 2,
      },
    ],
    [
      "wrong limit",
      {
        version: 1,
        operation: "listGitHubOwnerRepositories",
        direction: "next",
        owner: "octocat",
        repo: null,
        limit: 10,
        page: 2,
      },
    ],
    [
      "unknown direction",
      {
        version: 1,
        operation: "listGitHubOwnerRepositories",
        direction: "sideways",
        owner: "octocat",
        repo: null,
        limit: 20,
        page: 2,
      },
    ],
    [
      "impossible next page one",
      {
        version: 1,
        operation: "listGitHubOwnerRepositories",
        direction: "next",
        owner: "octocat",
        repo: null,
        limit: 20,
        page: 1,
      },
    ],
    [
      "extra provider member",
      {
        version: 1,
        operation: "listGitHubRepositoryActivity",
        direction: "next",
        owner: "octocat",
        repo: "repo",
        limit: 20,
        value: "n1",
        after: "n1",
      },
    ],
  ])("rejects a wrong-scope cursor without fetching: %s", async (_name, state) => {
    const fetch = injectedFetch(async () => jsonResponse([]));
    await problem(
      await request(fetch, `/v1/github/owners/octocat/repos?cursor=${encodeCursor(state)}`),
      400,
      "invalid_request",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["A", "e30=", "eyAidmVyc2lvbiI6MSB9"])("rejects malformed or noncanonical cursor %s", async (cursor) => {
    const fetch = injectedFetch(async () => jsonResponse([]));
    await problem(await request(fetch, `/v1/github/owners/octocat/repos?cursor=${cursor}`), 400, "invalid_request");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects negotiation and unsupported methods before provider work", async () => {
    const fetch = injectedFetch(async () => jsonResponse(OWNER));
    await problem(
      await request(fetch, "/v1/github/owners/octocat", { headers: { Accept: "application/json;q=0" } }),
      406,
      "not_acceptable",
    );
    const method = await request(fetch, "/v1/github/owners/octocat", {
      method: "POST",
      headers: { Accept: "text/plain", "Content-Type": "text/plain" },
      body: "must-not-be-consumed",
    });
    await problem(method, 405, "method_not_allowed");
    expect(method.headers.get("Allow")).toBe("GET, HEAD");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails local public-limit rejection and dependency outage before provider work", async () => {
    const fetch = injectedFetch(async () => jsonResponse(OWNER));
    const rejected = vi.fn(async () => ({ success: false }));
    const limitedBindings = {
      ...TEST_BINDINGS,
      RATE_LIMIT_MODE: "workers-binding",
      RATE_LIMIT_KEY_HMAC_KEY: RATE_LIMIT_KEY,
      PUBLIC_RATE_LIMITER: { limit: rejected } as unknown as RateLimit,
    } satisfies RuntimeBindings;
    const limited = await request(fetch, "/v1/github/owners/octocat", {}, limitedBindings);
    await problem(limited, 429, "rate_limited");
    expect(limited.headers.get("Retry-After")).toBe("60");

    const unavailableBindings = {
      ...TEST_BINDINGS,
      RATE_LIMIT_MODE: "workers-binding",
      RATE_LIMIT_KEY_HMAC_KEY: RATE_LIMIT_KEY,
    } satisfies RuntimeBindings;
    await problem(
      await request(fetch, "/v1/github/owners/octocat", {}, unavailableBindings),
      503,
      "dependency_unavailable",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledTimes(1);
  });
});

describe("GitHub cursor translation", () => {
  it("round-trips non-adjacent numbered next and previous links through opaque public cursors", async () => {
    const fetch = sequenceFetch(
      jsonResponse([SUMMARY], 200, {
        Link: '<https://api.github.com/user/1/repos?type=owner&sort=full_name&direction=asc&per_page=2&page=3>; rel="next"',
      }),
      jsonResponse([{ ...SUMMARY, id: 3 }], 200, {
        Link: '<https://api.github.com/user/1/repos?type=owner&sort=full_name&direction=asc&per_page=2&page=1>; rel="prev"',
      }),
      jsonResponse([SUMMARY]),
    );

    const first = await request(fetch, "/v1/github/owners/octocat/repos?limit=2");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ count: 1, repos: [{ id: 2 }] });
    expect(first.headers.get("Link")).not.toContain('rel="prev"');
    const next = linkTarget(first.headers.get("Link"), "next");

    const third = await request(fetch, next);
    expect(await third.json()).toMatchObject({ count: 1, repos: [{ id: 3 }] });
    expect(third.headers.get("Link")).not.toContain('rel="next"');
    const previous = linkTarget(third.headers.get("Link"), "prev");

    const back = await request(fetch, previous);
    expect(await back.json()).toMatchObject({ count: 1, repos: [{ id: 2 }] });
    expect(back.headers.get("Link")).toBeNull();

    const calls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(calls).toEqual([
      "https://api.github.com/users/octocat/repos?type=owner&sort=full_name&direction=asc&per_page=2",
      "https://api.github.com/users/octocat/repos?type=owner&sort=full_name&direction=asc&per_page=2&page=3",
      "https://api.github.com/users/octocat/repos?type=owner&sort=full_name&direction=asc&per_page=2",
    ]);
  });

  it("maps public activity next to after and previous to before only", async () => {
    const fetch = sequenceFetch(
      jsonResponse([ACTIVITY], 200, {
        Link: '<https://api.github.com/repositories/2/activity?direction=desc&per_page=1&after=next-provider>; rel="next"',
      }),
      jsonResponse([{ ...ACTIVITY, id: 4 }], 200, {
        Link: '<https://api.github.com/repositories/2/activity?direction=desc&per_page=1&before=previous-provider>; rel="prev"',
      }),
      jsonResponse([ACTIVITY]),
    );

    const first = await request(fetch, "/v1/github/repos/octocat/repo/activity?limit=1");
    const next = linkTarget(first.headers.get("Link"), "next");
    const second = await request(fetch, next);
    const previous = linkTarget(second.headers.get("Link"), "prev");
    await request(fetch, previous);

    const secondUpstream = new URL(String(vi.mocked(fetch).mock.calls[1]?.[0]));
    expect(secondUpstream.searchParams.get("after")).toBe("next-provider");
    expect(secondUpstream.searchParams.has("before")).toBe(false);
    const thirdUpstream = new URL(String(vi.mocked(fetch).mock.calls[2]?.[0]));
    expect(thirdUpstream.searchParams.get("before")).toBe("previous-provider");
    expect(thirdUpstream.searchParams.has("after")).toBe(false);
  });
});

describe("GitHub controlled failures and OpenAPI agreement", () => {
  it("normalizes valid provider offsets and rejects malformed provider URLs at the Hono boundary", async () => {
    const normalized = await request(
      sequenceFetch(
        jsonResponse({
          ...OWNER,
          created_at: "2011-01-25t20:14:36+01:30",
          updated_at: "2023-12-31T19:00:00.1000-05:00",
        }),
      ),
      "/v1/github/owners/octocat",
    );
    expect(normalized.status).toBe(200);
    await expect(normalized.json()).resolves.toMatchObject({
      createdAt: "2011-01-25T18:44:36.000Z",
      updatedAt: "2024-01-01T00:00:00.100Z",
    });

    const malformed = await request(
      sequenceFetch(jsonResponse({ ...OWNER, avatar_url: "https://example.test/%zz" })),
      "/v1/github/owners/octocat",
    );
    expect((await problem(malformed, 502, "github_upstream")).detail).toBe(
      "GitHub upstream response is invalid or unavailable",
    );
  });

  it("exposes truthful provider quota fields and fixed safe failures", async () => {
    const quotaFetch = sequenceFetch(
      new Response("provider secret", {
        status: 429,
        headers: { "Retry-After": "7", "X-RateLimit-Reset": "9999999999" },
      }),
    );
    const quota = await request(quotaFetch, "/v1/github/owners/octocat");
    const quotaBody = await problem(quota, 429, "github_rate_limit");
    expect(quotaBody.detail).toBe("GitHub rate limit exceeded");
    expect(quota.headers.get("Retry-After")).toBe("7");
    expect(quota.headers.get("X-RateLimit-Reset")).toBe("9999999999");

    const upstream = await request(sequenceFetch(jsonResponse({ ...OWNER, id: -1 })), "/v1/github/owners/octocat");
    expect((await problem(upstream, 502, "github_upstream")).detail).toBe(
      "GitHub upstream response is invalid or unavailable",
    );
  });

  it("does not expose transport causes in the public problem or structured logs", async () => {
    const sensitive = "token=github-secret https://api.github.com/private?credential=secret";
    const response = await request(
      injectedFetch(async () => Promise.reject(new Error(sensitive))),
      "/v1/github/owners/octocat",
    );
    const body = await problem(response, 502, "github_upstream");

    expect(JSON.stringify(body)).not.toContain(sensitive);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(sensitive);
    expect(errorSpy.mock.calls.flat()).toContainEqual(expect.objectContaining({ code: "github_transport_failure" }));
  });

  it("generates the exact GitHub operations, statuses, headers, and closed public schemas", async () => {
    const app = createApp();
    const response = await app.request(new Request(`${ORIGIN}/openapi.json`), undefined, TEST_BINDINGS);
    const document = (await response.json()) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const operations = [
      ["/v1/github/owners/{owner}", "getGitHubOwner", false],
      ["/v1/github/owners/{owner}/repos", "listGitHubOwnerRepositories", true],
      ["/v1/github/repos/{owner}/{repo}", "getGitHubRepository", false],
      ["/v1/github/repos/{owner}/{repo}/activity", "listGitHubRepositoryActivity", true],
      ["/v1/github/repos/{owner}/{repo}/languages", "listGitHubRepositoryLanguages", false],
      ["/v1/github/repos/{owner}/{repo}/tags", "listGitHubRepositoryTags", true],
    ] as const;
    const expectedStatuses = ["200", "400", "404", "406", "422", "429", "500", "502", "503", "504"];

    for (const [path, operationId, paginated] of operations) {
      const operation = document.paths[path]?.["get"] as {
        operationId?: string;
        security?: unknown;
        requestBody?: unknown;
        responses?: Record<
          string,
          { headers?: Record<string, { required?: boolean; schema?: Record<string, unknown> }> }
        >;
      };
      expect(operation.operationId).toBe(operationId);
      expect(operation.security).toEqual([]);
      expect(operation.requestBody).toBeUndefined();
      expect(Object.keys(operation.responses ?? {}).sort()).toEqual(expectedStatuses);
      for (const result of Object.values(operation.responses ?? {})) {
        expect(result.headers?.["X-Request-ID"]?.required).toBe(true);
      }
      if (paginated) expect(operation.responses?.["200"]?.headers).toHaveProperty("Link");
      const quota = operation.responses?.["429"]?.headers;
      expect(quota?.["Retry-After"]?.required).toBe(true);
      expect(quota?.["Retry-After"]?.schema).toMatchObject({
        type: "integer",
        minimum: 0,
        maximum: 9_007_199_254_740_991,
      });
      expect(quota?.["X-RateLimit-Reset"]?.required).toBe(false);
    }

    for (const name of [
      "GitHubOwner",
      "GitHubRepositorySummary",
      "GitHubRepository",
      "GitHubActivity",
      "GitHubLanguage",
      "GitHubTag",
      "GitHubRepositoryPage",
      "GitHubActivityPage",
      "GitHubLanguages",
      "GitHubTagPage",
    ]) {
      expect(document.components.schemas[name]?.["additionalProperties"]).toBe(false);
    }
    expect(document.components.schemas["GitHubOwner"]?.["required"]).toEqual(
      expect.arrayContaining(["id", "login", "name", "createdAt", "updatedAt"]),
    );
    const repository = document.components.schemas["GitHubRepository"] as {
      properties?: Record<string, Record<string, unknown>>;
    };
    expect(repository.properties?.["topics"]).toMatchObject({ type: "array", uniqueItems: true });
    expect(JSON.stringify(document)).not.toContain("GITHUB_TOKEN");
    expect(JSON.stringify(document)).not.toContain("X-GitHub-Api-Version");
  });
});
