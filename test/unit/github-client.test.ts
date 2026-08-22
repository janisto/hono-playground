import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/core/errors.ts";
import { GITHUB_TRANSPORT_LIMITS, GitHubClient } from "../../src/services/github-client.ts";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;
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

const injectedFetch = (implementation: FetchImplementation): typeof globalThis.fetch =>
  vi.fn(implementation) as unknown as typeof globalThis.fetch;

const jsonResponse = (value: unknown, status = 200, headers: HeadersInit = {}): Response => {
  const responseHeaders = new Headers(JSON_HEADERS);
  new Headers(headers).forEach((headerValue, name) => {
    responseHeaders.set(name, headerValue);
  });
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
};

const rawResponse = (body: BodyInit | null, status = 200, headers: HeadersInit = JSON_HEADERS): Response =>
  new Response(body, { status, headers });

const sequenceFetch = (...responses: Response[]): typeof globalThis.fetch => {
  const queue = [...responses];
  return injectedFetch(async () => {
    const response = queue.shift();
    if (response === undefined) throw new Error("Unexpected fetch");
    return response;
  });
};

const expectCode = async (promise: Promise<unknown>, code: AppError["code"]): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code });
    return error as AppError;
  }
  throw new Error(`Expected ${code}`);
};

describe("GitHubClient request and projection", () => {
  it("sends one anonymous GET with exactly the four literal provider headers", async () => {
    const fetch = injectedFetch(async () => jsonResponse(OWNER));
    const client = new GitHubClient({ fetch });

    await expect(client.getOwner("octocat")).resolves.toMatchObject({ id: 1 });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(String(input)).toBe("https://api.github.com/users/octocat");
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect([...new Headers(init?.headers).entries()]).toEqual([
      ["accept", "application/vnd.github+json"],
      ["accept-encoding", "identity"],
      ["user-agent", "hono-playground"],
      ["x-github-api-version", "2026-03-10"],
    ]);
  });

  it("resolves the default global fetch at request time so the outbound guard cannot be bypassed", async () => {
    const previousFetch = globalThis.fetch;
    const constructionFetch = injectedFetch(async () => jsonResponse({ ...OWNER, id: 999 }));
    const requestFetch = injectedFetch(async () => jsonResponse(OWNER));
    try {
      globalThis.fetch = constructionFetch;
      const client = new GitHubClient();
      globalThis.fetch = requestFetch;

      await expect(client.getOwner("octocat")).resolves.toMatchObject({ id: 1 });
    } finally {
      globalThis.fetch = previousFetch;
    }

    expect(constructionFetch).not.toHaveBeenCalled();
    expect(requestFetch).toHaveBeenCalledOnce();
  });

  it("projects only public owner members and canonicalizes accepted provider timestamps", async () => {
    const fetch = injectedFetch(async () =>
      jsonResponse({
        ...OWNER,
        name: "",
        company: undefined,
        created_at: "2011-01-25t20:14:36+01:30",
        updated_at: "2023-12-31T19:00:00.1000-05:00",
        email: "must-not-leak@example.test",
        arbitrary_addition: { secret: true },
      }),
    );

    await expect(new GitHubClient({ fetch }).getOwner("octocat")).resolves.toEqual({
      id: 1,
      login: "octocat",
      type: "User",
      name: null,
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
      updatedAt: "2024-01-01T00:00:00.100Z",
    });
  });

  it("projects repository null defaults and sorts topics by Unicode scalar value", async () => {
    const fetch = sequenceFetch(
      jsonResponse({ ...DETAIL, language: "", license: undefined, topics: undefined }),
      jsonResponse({ ...DETAIL, topics: ["\u{10000}", "\uE000", "a", "A"], license: { spdx_id: "NOASSERTION" } }),
    );
    const client = new GitHubClient({ fetch });

    await expect(client.getRepository("octocat", "repo")).resolves.toMatchObject({
      language: "",
      license: null,
      topics: [],
      pushedAt: null,
    });
    await expect(client.getRepository("octocat", "repo")).resolves.toMatchObject({
      license: null,
      topics: ["A", "a", "\uE000", "\u{10000}"],
    });
  });

  it("constructs fixed collection queries, preserves page order, and validates numeric navigation", async () => {
    const headers = {
      Link: [
        '<https://api.github.com/user/1/repos?direction=asc&page=4&per_page=2&sort=full_name&type=owner>; rel="next"',
        '<https://api.github.com/users/octocat/repos?type=owner&sort=full_name&direction=asc&per_page=2&page=1>; rel="prev"',
      ].join(", "),
    };
    const fetch = injectedFetch(async () => jsonResponse([{ ...SUMMARY, id: 3 }, SUMMARY], 200, headers));

    const result = await new GitHubClient({ fetch }).listOwnerRepositories("octocat", 2, 3);

    expect(result).toEqual({
      items: [expect.objectContaining({ id: 3 }), expect.objectContaining({ id: 2 })],
      nextPage: 4,
      prevPage: 1,
    });
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe(
      "https://api.github.com/users/octocat/repos?type=owner&sort=full_name&direction=asc&per_page=2&page=3",
    );
  });

  it("maps activity, languages, and tags through their exact provider schemas", async () => {
    const fetch = sequenceFetch(
      jsonResponse([{ ...ACTIVITY, actor: null }, ACTIVITY], 200, {
        Link: '<https://api.github.com/repositories/2/activity?direction=desc&per_page=2&after=next-1>; rel="next"',
      }),
      jsonResponse({ TypeScript: 10, "\u{10000}": 5, "\uE000": 5 }),
      jsonResponse([TAG]),
    );
    const client = new GitHubClient({ fetch });

    await expect(client.listRepositoryActivity("octocat", "repo", 2, undefined)).resolves.toEqual({
      activities: [
        expect.objectContaining({ actor: null, actorAvatarUrl: null }),
        expect.objectContaining({ actor: "octocat", actorAvatarUrl: "https://avatars.githubusercontent.com/u/1" }),
      ],
      nextCursor: "next-1",
      prevCursor: null,
    });
    await expect(client.listRepositoryLanguages("octocat", "repo")).resolves.toEqual([
      { name: "TypeScript", bytes: 10 },
      { name: "\uE000", bytes: 5 },
      { name: "\u{10000}", bytes: 5 },
    ]);
    await expect(client.listRepositoryTags("octocat", "repo", 20, 1)).resolves.toEqual({
      items: [TAG],
      nextPage: null,
      prevPage: null,
    });
  });

  it("rejects a dot-only repository again at the URL-construction boundary", async () => {
    const fetch = injectedFetch(async () => jsonResponse(DETAIL));
    const client = new GitHubClient({ fetch });

    await expectCode(client.getRepository("octocat", "..."), "github_upstream");
    await expectCode(client.listRepositoryActivity("octocat", ".", 20, undefined), "github_upstream");
    await expectCode(client.listRepositoryLanguages("octocat", ".."), "github_upstream");
    await expectCode(client.listRepositoryTags("octocat", "...", 20, 1), "github_upstream");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("GitHubClient response validation", () => {
  it.each([
    ["missing projection member", { ...OWNER, login: undefined }],
    ["negative integer", { ...OWNER, id: -1 }],
    ["unsafe integer", { ...OWNER, id: 9_007_199_254_740_992 }],
    ["invalid URL", { ...OWNER, avatar_url: "ftp://example.test/avatar" }],
    ["URL with trailing whitespace", { ...OWNER, avatar_url: "https://example.test/avatar " }],
    ["URL with an unescaped space", { ...OWNER, avatar_url: "https://example.test/avatar image" }],
    ["URL with malformed percent encoding", { ...OWNER, avatar_url: "https://example.test/%zz" }],
    ["URL with a control character", { ...OWNER, avatar_url: "https://example.test/\u0000" }],
    ["HTTP URL with an empty host", { ...OWNER, avatar_url: "https:///avatar" }],
    ["nonexistent date", { ...OWNER, created_at: "2024-02-30T00:00:00.000Z" }],
    ["invalid timestamp offset", { ...OWNER, created_at: "2024-01-01T00:00:00+24:00" }],
    ["timestamp outside the public year range", { ...OWNER, created_at: "0000-01-01T00:00:00+00:01" }],
    ["non-millisecond-aligned date", { ...OWNER, created_at: "2024-01-01T00:00:00.0001Z" }],
  ])("rejects invalid owner data: %s", async (_name, value) => {
    await expectCode(
      new GitHubClient({ fetch: sequenceFetch(jsonResponse(value)) }).getOwner("octocat"),
      "github_upstream",
    );
  });

  it.each([
    ["private absent", { ...SUMMARY, private: undefined }],
    ["private true", { ...SUMMARY, private: true }],
    ["visibility absent", { ...SUMMARY, visibility: undefined }],
    ["visibility internal", { ...SUMMARY, visibility: "internal" }],
  ])("fails closed on a repository visibility violation: %s", async (_name, value) => {
    await expectCode(
      new GitHubClient({ fetch: sequenceFetch(jsonResponse([value])) }).listOwnerRepositories("octocat", 20, 1),
      "github_upstream",
    );
  });

  it("rejects duplicate JSON members and duplicate topics", async () => {
    const duplicateOwner = JSON.stringify(OWNER).replace('"login":"octocat"', '"login":"octocat","login":"other"');
    const client = new GitHubClient({
      fetch: sequenceFetch(rawResponse(duplicateOwner), jsonResponse({ ...DETAIL, topics: ["same", "same"] })),
    });

    await expectCode(client.getOwner("octocat"), "github_upstream");
    await expectCode(client.getRepository("octocat", "repo"), "github_upstream");
  });

  it("rejects inconsistent activity, invalid language, invalid tag, and every over-limit page", async () => {
    const fetch = sequenceFetch(
      jsonResponse([{ ...ACTIVITY, actor: { login: "octocat" } }]),
      jsonResponse({ "": 1 }),
      jsonResponse([{ ...TAG, commit: { sha: "ABC" } }]),
      jsonResponse([SUMMARY, { ...SUMMARY, id: 3 }]),
      jsonResponse([ACTIVITY, { ...ACTIVITY, id: 4 }]),
      jsonResponse([TAG, { ...TAG, name: "v2" }]),
    );
    const client = new GitHubClient({ fetch });

    await expectCode(client.listRepositoryActivity("octocat", "repo", 20, undefined), "github_upstream");
    await expectCode(client.listRepositoryLanguages("octocat", "repo"), "github_upstream");
    await expectCode(client.listRepositoryTags("octocat", "repo", 20, 1), "github_upstream");
    await expectCode(client.listOwnerRepositories("octocat", 1, 1), "github_upstream");
    await expectCode(client.listRepositoryActivity("octocat", "repo", 1, undefined), "github_upstream");
    await expectCode(client.listRepositoryTags("octocat", "repo", 1, 1), "github_upstream");
  });

  it.each([
    [undefined, null],
    ["text/json", "text/json"],
    ["application/json, application/json", "application/json, application/json"],
    ['application/json; charset="unterminated', 'application/json; charset="unterminated'],
    ["application/json; charset=utf-8; CHARSET=utf-8", "application/json; charset=utf-8; CHARSET=utf-8"],
  ])("rejects a missing or malformed JSON Content-Type: %s", async (_label, contentType) => {
    const headers = contentType === null ? {} : { "Content-Type": contentType };
    await expectCode(
      new GitHubClient({ fetch: sequenceFetch(rawResponse(JSON.stringify(OWNER), 200, headers)) }).getOwner("octocat"),
      "github_upstream",
    );
  });

  it.each(["application/problem+json", 'Application/JSON; Charset="utf-8"; note="a,b"'])(
    "accepts a syntactically valid JSON media type: %s",
    async (contentType) => {
      await expect(
        new GitHubClient({
          fetch: sequenceFetch(rawResponse(JSON.stringify(OWNER), 200, { "Content-Type": contentType })),
        }).getOwner("octocat"),
      ).resolves.toMatchObject({ id: 1 });
    },
  );

  it("rejects BOM, invalid UTF-8, trailing JSON, and duplicate top-level names", async () => {
    const ownerBytes = new TextEncoder().encode(JSON.stringify(OWNER));
    const bom = new Uint8Array(ownerBytes.length + 3);
    bom.set([0xef, 0xbb, 0xbf]);
    bom.set(ownerBytes, 3);
    const fetch = sequenceFetch(
      rawResponse(bom),
      rawResponse(new Uint8Array([0xc3, 0x28])),
      rawResponse(`${JSON.stringify(OWNER)} trailing`),
      rawResponse('{"login":"one","login":"two"}'),
    );
    const client = new GitHubClient({ fetch });

    for (let index = 0; index < 4; index += 1) await expectCode(client.getOwner("octocat"), "github_upstream");
  });

  it("enforces the 4 MiB boundary with missing, truthful, and misleading lengths", async () => {
    const maximum = GITHUB_TRANSPORT_LIMITS.maximumResponseBytes;
    const empty = JSON.stringify({ ...OWNER, padding: "" });
    const exact = JSON.stringify({ ...OWNER, padding: "x".repeat(maximum - empty.length) });
    const exactBytes = new TextEncoder().encode(exact);
    expect(exactBytes).toHaveLength(maximum);
    const over = new Uint8Array(maximum + 1);
    over.set(exactBytes);
    over[maximum] = 0x20;

    const streamed = (bytes: Uint8Array): ReadableStream<Uint8Array> => {
      let offset = 0;
      return new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (offset >= bytes.length) {
              controller.close();
              return;
            }
            const end = Math.min(offset + 262_144, bytes.length);
            controller.enqueue(bytes.subarray(offset, end));
            offset = end;
          },
        },
        { highWaterMark: 0 },
      );
    };
    const fetch = sequenceFetch(
      rawResponse(exact),
      rawResponse(exact, 200, { ...JSON_HEADERS, "Content-Length": String(maximum) }),
      rawResponse(streamed(exactBytes), 200, { ...JSON_HEADERS, "Content-Length": "1" }),
      rawResponse(over),
      rawResponse(over, 200, { ...JSON_HEADERS, "Content-Length": String(maximum + 1) }),
      rawResponse(streamed(over), 200, { ...JSON_HEADERS, "Content-Length": "1" }),
    );
    const client = new GitHubClient({ fetch });

    for (let index = 0; index < 3; index += 1) {
      await expect(client.getOwner("octocat")).resolves.toMatchObject({ id: 1 });
    }
    for (let index = 0; index < 3; index += 1) await expectCode(client.getOwner("octocat"), "github_upstream");
  });

  it("rejects an oversized declared success without reading its body", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ cancel });
    const response = rawResponse(stream, 200, {
      ...JSON_HEADERS,
      "Content-Length": String(GITHUB_TRANSPORT_LIMITS.maximumResponseBytes + 1),
    });

    await expectCode(new GitHubClient({ fetch: sequenceFetch(response) }).getOwner("octocat"), "github_upstream");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("validates identity content encoding before mapping any status", async () => {
    const cancel = vi.fn();
    const response = rawResponse(new ReadableStream({ cancel }), 404, { "Content-Encoding": "gzip" });
    await expectCode(new GitHubClient({ fetch: sequenceFetch(response) }).getOwner("octocat"), "github_upstream");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("GitHubClient pagination links", () => {
  it("parses quoted commas and ignores anchored and irrelevant relations without following targets", async () => {
    const link = [
      '<https://api.github.com/repositories/2/activity?direction=desc&per_page=20&after=n1>; title="a,b"; rel="NeXt"',
      '<https://evil.example/ignored>; rel="last"',
      '<https://evil.example/anchored>; anchor="/alternate"; rel="prev"',
    ].join(", ");
    const fetch = injectedFetch(async () => jsonResponse([ACTIVITY], 200, { Link: link }));

    await expect(
      new GitHubClient({ fetch }).listRepositoryActivity("octocat", "repo", 20, undefined),
    ).resolves.toMatchObject({
      nextCursor: "n1",
      prevCursor: null,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts backward activity state and rejects an exact provider cursor replay", async () => {
    const fetch = sequenceFetch(
      jsonResponse([ACTIVITY], 200, {
        Link: '<https://api.github.com/repos/octocat/repo/activity?direction=desc&per_page=20&before=older>; rel="prev"',
      }),
      jsonResponse([ACTIVITY], 200, {
        Link: '<https://api.github.com/repos/octocat/repo/activity?direction=desc&per_page=20&after=same>; rel="next"',
      }),
    );
    const client = new GitHubClient({ fetch });

    await expect(
      client.listRepositoryActivity("octocat", "repo", 20, { direction: "after", value: "current" }),
    ).resolves.toMatchObject({ prevCursor: "older" });
    await expectCode(
      client.listRepositoryActivity("octocat", "repo", 20, { direction: "after", value: "same" }),
      "github_upstream",
    );
  });

  it.each([
    [
      "cross origin",
      '<https://evil.example/user/1/repos?type=owner&sort=full_name&direction=asc&per_page=20&page=2>; rel="next"',
    ],
    [
      "wrong path",
      '<https://api.github.com/repositories/1/repos?type=owner&sort=full_name&direction=asc&per_page=20&page=2>; rel="next"',
    ],
    [
      "missing page",
      '<https://api.github.com/user/1/repos?type=owner&sort=full_name&direction=asc&per_page=20>; rel="next"',
    ],
    [
      "noncanonical page",
      '<https://api.github.com/user/1/repos?type=owner&sort=full_name&direction=asc&per_page=20&page=02>; rel="next"',
    ],
    [
      "nonadvancing page",
      '<https://api.github.com/user/1/repos?type=owner&sort=full_name&direction=asc&per_page=20&page=1>; rel="next"',
    ],
    [
      "extra query",
      '<https://api.github.com/user/1/repos?type=owner&sort=full_name&direction=asc&per_page=20&page=2&x=1>; rel="next"',
    ],
    [
      "duplicate relation",
      '<https://api.github.com/user/1/repos?type=owner&sort=full_name&direction=asc&per_page=20&page=2>; rel="next", <https://api.github.com/user/1/repos?type=owner&sort=full_name&direction=asc&per_page=20&page=2>; rel="next"',
    ],
    [
      "malformed relevant relation",
      '<https://api.github.com/user/1/repos?type=owner&sort=full_name&direction=asc&per_page=20&page=2>; rel="next',
    ],
  ])("rejects an unsafe numbered Link: %s", async (_name, link) => {
    await expectCode(
      new GitHubClient({ fetch: sequenceFetch(jsonResponse([SUMMARY], 200, { Link: link })) }).listOwnerRepositories(
        "octocat",
        20,
        1,
      ),
      "github_upstream",
    );
  });

  it("rejects semantically invalid activity navigation and empty pages with next", async () => {
    const fetch = sequenceFetch(
      jsonResponse([ACTIVITY], 200, {
        Link: '<https://api.github.com/repositories/2/activity?direction=desc&per_page=20&before=prior>; rel="prev"',
      }),
      jsonResponse([ACTIVITY], 200, {
        Link: '<https://api.github.com/repositories/2/activity?direction=desc&per_page=20&before=wrong>; rel="next"',
      }),
      jsonResponse([], 200, {
        Link: '<https://api.github.com/repositories/2/tags?per_page=20&page=2>; rel="next"',
      }),
    );
    const client = new GitHubClient({ fetch });

    await expectCode(client.listRepositoryActivity("octocat", "repo", 20, undefined), "github_upstream");
    await expectCode(
      client.listRepositoryActivity("octocat", "repo", 20, { direction: "after", value: "current" }),
      "github_upstream",
    );
    await expectCode(client.listRepositoryTags("octocat", "repo", 20, 1), "github_upstream");
  });
});

describe("GitHubClient redirects, failures, and cancellation", () => {
  it.each([
    ["owner", "/user/1", (client: GitHubClient) => client.getOwner("octocat"), OWNER],
    [
      "owner repositories",
      "/user/1/repos?type=owner&sort=full_name&direction=asc&per_page=20",
      (client: GitHubClient) => client.listOwnerRepositories("octocat", 20, 1),
      [SUMMARY],
    ],
    ["repository", "/repositories/2", (client: GitHubClient) => client.getRepository("octocat", "repo"), DETAIL],
    [
      "activity",
      "/repositories/2/activity?direction=desc&per_page=20",
      (client: GitHubClient) => client.listRepositoryActivity("octocat", "repo", 20, undefined),
      [ACTIVITY],
    ],
    [
      "languages",
      "/repositories/2/languages",
      (client: GitHubClient) => client.listRepositoryLanguages("octocat", "repo"),
      { TypeScript: 1 },
    ],
    [
      "tags",
      "/repositories/2/tags?per_page=20",
      (client: GitHubClient) => client.listRepositoryTags("octocat", "repo", 20, 1),
      [TAG],
    ],
  ] as const)("follows one exact named-to-numeric redirect for %s", async (_name, location, invoke, body) => {
    const fetch = sequenceFetch(
      rawResponse(null, 301, { Location: location, "Content-Encoding": "identity" }),
      jsonResponse(body),
    );
    await expect(invoke(new GitHubClient({ fetch }))).resolves.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(fetch).mock.calls[1]?.[0])).toBe(`https://api.github.com${location}`);
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.signal).toBe(vi.mocked(fetch).mock.calls[0]?.[1]?.signal);
  });

  it.each([
    ["missing location", {}],
    ["cross origin", { Location: "https://evil.example/user/1" }],
    ["credentials", { Location: "https://user@api.github.com/user/1" }],
    ["fragment", { Location: "https://api.github.com/user/1#fragment" }],
    ["wrong path", { Location: "https://api.github.com/repos/octocat/repo" }],
    ["changed query", { Location: "https://api.github.com/user/1?extra=1" }],
    ["noncanonical id", { Location: "https://api.github.com/user/01" }],
  ])("rejects an unsafe owner redirect: %s", async (_name, headers) => {
    await expectCode(
      new GitHubClient({ fetch: sequenceFetch(rawResponse(null, 302, headers)) }).getOwner("octocat"),
      "github_upstream",
    );
  });

  it("rejects a repeated Location, redirect loop, and fourth redirect", async () => {
    const repeated = new Headers({ Location: "/user/1" });
    repeated.append("Location", "/user/2");
    await expectCode(
      new GitHubClient({ fetch: sequenceFetch(rawResponse(null, 302, repeated)) }).getOwner("octocat"),
      "github_upstream",
    );

    await expectCode(
      new GitHubClient({
        fetch: sequenceFetch(
          rawResponse(null, 302, { Location: "/user/1" }),
          rawResponse(null, 302, { Location: "/users/octocat" }),
        ),
      }).getOwner("octocat"),
      "github_upstream",
    );

    const fetch = sequenceFetch(
      rawResponse(null, 302, { Location: "/user/1" }),
      rawResponse(null, 302, { Location: "/user/2" }),
      rawResponse(null, 302, { Location: "/user/3" }),
      rawResponse(null, 302, { Location: "/user/4" }),
    );
    await expectCode(new GitHubClient({ fetch }).getOwner("octocat"), "github_upstream");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each([201, 204, 401, 410, 422, 500, 599])("maps unexpected provider status %i to upstream", async (status) => {
    await expectCode(
      new GitHubClient({ fetch: sequenceFetch(rawResponse(null, status)) }).getOwner("octocat"),
      "github_upstream",
    );
  });

  it("maps 404 without parsing the provider body and ignores quota hints", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ cancel });
    const error = await expectCode(
      new GitHubClient({
        fetch: sequenceFetch(rawResponse(stream, 404, { "Retry-After": "1", "X-RateLimit-Reset": "9999999999" })),
      }).getOwner("octocat"),
      "github_not_found",
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect([...error.headers]).toEqual([]);
  });

  it.each([403, 429])("maps provider %i to quota failure without parsing its body", async (status) => {
    const cancel = vi.fn();
    const error = await expectCode(
      new GitHubClient({
        fetch: sequenceFetch(rawResponse(new ReadableStream({ cancel }), status, { "Retry-After": "7" })),
      }).getOwner("octocat"),
      "github_rate_limit",
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(error.headers.get("Retry-After")).toBe("7");
  });

  it.each([
    ["valid retry and reset", { "Retry-After": "7", "X-RateLimit-Reset": "102" }, "7", "102"],
    ["invalid retry and valid reset", { "Retry-After": "07", "X-RateLimit-Reset": "102" }, "2", "102"],
    ["valid retry and invalid reset", { "Retry-After": "0", "X-RateLimit-Reset": "100" }, "0", null],
    ["maximum retry", { "Retry-After": "9007199254740991" }, "9007199254740991", null],
    ["overflow hints", { "Retry-After": "9007199254740992", "X-RateLimit-Reset": "9007199254740992" }, "60", null],
    ["comma-combined hints", { "Retry-After": "1, 2", "X-RateLimit-Reset": "102, 103" }, "60", null],
  ] as const)("validates quota hints independently: %s", async (_name, headers, retry, reset) => {
    const error = await expectCode(
      new GitHubClient({ fetch: sequenceFetch(rawResponse(null, 429, headers)), now: () => 100_250 }).getOwner(
        "octocat",
      ),
      "github_rate_limit",
    );
    expect(error.headers.get("Retry-After")).toBe(retry);
    expect(error.headers.get("X-RateLimit-Reset")).toBe(reset);
  });

  it("takes one clock snapshot when deriving quota delay", async () => {
    const now = vi.fn(() => 100_250);
    const error = await expectCode(
      new GitHubClient({
        fetch: sequenceFetch(rawResponse(null, 403, { "X-RateLimit-Reset": "102" })),
        now,
      }).getOwner("octocat"),
      "github_rate_limit",
    );
    expect(error.headers.get("Retry-After")).toBe("2");
    expect(error.headers.get("X-RateLimit-Reset")).toBe("102");
    expect(now).toHaveBeenCalledTimes(1);
  });

  it("maps transport failure and deadline expiry without exposing the cause", async () => {
    const transport = new Error("token=secret provider.example/private");
    const transportError = await expectCode(
      new GitHubClient({ fetch: injectedFetch(async () => Promise.reject(transport)) }).getOwner("octocat"),
      "github_upstream",
    );
    expect(transportError.message).toBe("github_upstream");

    const deadline = new AbortController();
    const fetch = injectedFetch(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );
    const pending = new GitHubClient({ fetch, deadlineSignal: () => deadline.signal }).getOwner("octocat");
    deadline.abort(new DOMException("deadline", "TimeoutError"));
    await expectCode(pending, "github_timeout");
  });

  it("uses one overall deadline across redirects without relying on timer dispatch", async () => {
    let elapsed = 0;
    const deadlineSignal = vi.fn(() => new AbortController().signal);
    const responses = [
      rawResponse(null, 302, { Location: "/user/1" }),
      rawResponse(null, 302, { Location: "/user/2" }),
      jsonResponse(OWNER),
    ];
    const fetch = injectedFetch(async () => {
      elapsed += 4_000;
      const response = responses.shift();
      if (response === undefined) throw new Error("Unexpected fetch");
      return response;
    });
    const client = new GitHubClient({ fetch, deadlineNow: () => elapsed, deadlineSignal });

    await expectCode(client.getOwner("octocat"), "github_timeout");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(deadlineSignal).toHaveBeenCalledExactlyOnceWith(10_000);
    const signals = vi.mocked(fetch).mock.calls.map((call) => call[1]?.signal);
    expect(new Set(signals)).toHaveLength(1);
  });

  it("keeps public projection inside the overall deadline", async () => {
    let elapsed = 0;
    const originalToSorted = Array.prototype.toSorted;
    const projectionSort = vi.spyOn(Array.prototype, "toSorted").mockImplementation(function (
      this: unknown[],
      compareFn,
    ) {
      const sorted = Reflect.apply(originalToSorted, this, [compareFn]);
      if (this.includes("z") && this.includes("A")) elapsed = GITHUB_TRANSPORT_LIMITS.deadlineMilliseconds;
      return sorted;
    });
    const client = new GitHubClient({
      fetch: sequenceFetch(jsonResponse(DETAIL)),
      deadlineNow: () => elapsed,
      deadlineSignal: () => new AbortController().signal,
    });

    await expectCode(client.getRepository("octocat", "repo"), "github_timeout");
    expect(projectionSort).toHaveBeenCalled();
  });

  it("interrupts a pending response-body read when the overall deadline expires", async () => {
    const deadline = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = rawResponse(body);
    const fetch = sequenceFetch(response);
    const pending = new GitHubClient({ fetch, deadlineSignal: () => deadline.signal }).getOwner("octocat");
    await vi.waitFor(() => expect(response.body?.locked).toBe(true));

    deadline.abort(new DOMException("deadline", "TimeoutError"));

    await expectCode(pending, "github_timeout");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  it("propagates caller cancellation instead of reporting a provider outcome", async () => {
    const caller = new AbortController();
    const reason = new DOMException("caller disconnected", "AbortError");
    const fetch = injectedFetch(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );
    const pending = new GitHubClient({ fetch }).getOwner("octocat", caller.signal);
    caller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid test-boundary configuration", () => {
    expect(() => new GitHubClient({ baseUrl: "ftp://api.github.com" })).toThrow(TypeError);
    expect(() => new GitHubClient({ baseUrl: "https://api.github.com/path" })).toThrow(TypeError);
    expect(() => new GitHubClient({ timeoutMilliseconds: 0 })).toThrow(TypeError);
  });
});
