import type { z } from "zod";
import { AppError } from "../core/errors.ts";
import { assertStrictJsonText } from "../core/strict-json.ts";
import type {
  GitHubActivity,
  GitHubLanguage,
  GitHubOwner,
  GitHubRepository,
  GitHubRepositorySummary,
  GitHubTag,
} from "../models/github.ts";
import { SAFE_INTEGER_MAXIMUM } from "../models/portable.ts";
import {
  canonicalProviderTimestamp,
  type RawGitHubActivity,
  RawGitHubActivityPageSchema,
  RawGitHubLanguagesSchema,
  type RawGitHubOwner,
  RawGitHubOwnerSchema,
  type RawGitHubRepository,
  RawGitHubRepositoryPageSchema,
  RawGitHubRepositorySchema,
  type RawGitHubRepositorySummary,
  RawGitHubTagPageSchema,
} from "./github-upstream.ts";

const GITHUB_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_DEADLINE_MILLISECONDS = 10_000;
const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 4_194_304;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

export type GitHubFetch = typeof fetch;

export type GitHubClientOptions = Readonly<{
  fetch?: GitHubFetch;
  baseUrl?: string;
  timeoutMilliseconds?: number;
  now?: () => number;
  deadlineNow?: () => number;
  deadlineSignal?: (milliseconds: number) => AbortSignal;
}>;

export type NumberedPage<T> = Readonly<{ items: T[]; nextPage: number | null; prevPage: number | null }>;
export type ActivityCursor = Readonly<{ direction: "after" | "before"; value: string }>;
export type ActivityPage = Readonly<{
  activities: GitHubActivity[];
  nextCursor: string | null;
  prevCursor: string | null;
}>;

type LinkRelation = "next" | "prev";
type RelevantLink = Readonly<{ target: string; relations: LinkRelation[] }>;
type GitHubJsonResult<T> = Readonly<{ data: T; headers: Headers; assertActive: () => void }>;
type RedirectSuffix = "" | "/repos" | "/activity" | "/languages" | "/tags";

const awaitWithSignal = async <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
};

const canonicalSafeInteger = (value: string): number | null => {
  if (!CANONICAL_DECIMAL.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= SAFE_INTEGER_MAXIMUM ? parsed : null;
};

export const scalarCompare = (left: string, right: string): number => {
  const leftScalars = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const rightScalars = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  const count = Math.min(leftScalars.length, rightScalars.length);
  for (let index = 0; index < count; index += 1) {
    const difference = (leftScalars[index] ?? 0) - (rightScalars[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftScalars.length - rightScalars.length;
};

const splitMediaType = (value: string): string[] | null => {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) escaped = false;
    else if (quoted && character === "\\") escaped = true;
    else if (character === '"') quoted = !quoted;
    else if (!quoted && character === ",") return null;
    else if (!quoted && character === ";") {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted || escaped) return null;
  parts.push(value.slice(start));
  return parts;
};

const validQuotedString = (value: string): boolean => {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return false;
  for (let index = 1; index < value.length - 1; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x5c) {
      index += 1;
      if (index >= value.length - 1) return false;
      const escaped = value.charCodeAt(index);
      if (escaped !== 0x09 && (escaped < 0x20 || escaped === 0x7f)) return false;
    } else if (code !== 0x09 && (code < 0x20 || code === 0x22 || code === 0x7f)) {
      return false;
    }
  }
  return true;
};

const decodeQuotedString = (value: string): string | null => {
  if (!validQuotedString(value)) return null;
  let result = "";
  for (let index = 1; index < value.length - 1; index += 1) {
    if (value[index] === "\\") index += 1;
    result += value[index] ?? "";
  }
  return result;
};

const validJsonMediaType = (value: string): boolean => {
  const parts = splitMediaType(value);
  const rawMediaType = parts?.shift()?.trim().toLowerCase();
  if (parts === null || rawMediaType === undefined) return false;
  const slash = rawMediaType.indexOf("/");
  if (slash <= 0 || rawMediaType.indexOf("/", slash + 1) >= 0) return false;
  const type = rawMediaType.slice(0, slash);
  const subtype = rawMediaType.slice(slash + 1);
  if (!HTTP_TOKEN.test(type) || !HTTP_TOKEN.test(subtype)) return false;
  if (rawMediaType !== "application/json" && !(type === "application" && subtype.endsWith("+json"))) return false;
  const names = new Set<string>();
  for (const raw of parts) {
    const parameter = raw.trim();
    const equals = parameter.indexOf("=");
    if (equals <= 0) return false;
    const name = parameter.slice(0, equals).trim().toLowerCase();
    const parameterValue = parameter.slice(equals + 1).trim();
    if (!HTTP_TOKEN.test(name) || names.has(name)) return false;
    if (!HTTP_TOKEN.test(parameterValue) && !validQuotedString(parameterValue)) return false;
    names.add(name);
  }
  return true;
};

const splitLinkValues = (value: string): string[] => {
  const result: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let angle = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "<") angle = true;
    else if (character === ">") angle = false;
    else if (character === "," && !angle) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result.filter(Boolean);
};

const splitLinkParameters = (value: string): string[] | null => {
  const result: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let angle = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "<") angle = true;
    else if (character === ">") angle = false;
    else if (character === ";" && !angle) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted || escaped || angle) return null;
  result.push(value.slice(start).trim());
  return result;
};

const parameterName = (value: string): string => {
  const equals = value.indexOf("=");
  return (equals < 0 ? value : value.slice(0, equals)).trim().toLowerCase();
};

const parseRelevantLink = (value: string): RelevantLink | null => {
  const parts = splitLinkParameters(value);
  if (parts === null) {
    if (/(?:^|;)\s*rel\s*=/iu.test(value)) throw new TypeError("invalid Link relation");
    return null;
  }
  const parameters = parts.slice(1);
  if (parameters.some((parameter) => parameterName(parameter) === "anchor")) return null;
  const relations: string[] = [];
  for (const parameter of parameters) {
    if (parameterName(parameter) !== "rel") continue;
    const equals = parameter.indexOf("=");
    const raw = equals < 0 ? "" : parameter.slice(equals + 1).trim();
    const decoded = HTTP_TOKEN.test(raw) ? raw : decodeQuotedString(raw);
    if (decoded === null || decoded.length === 0) throw new TypeError("invalid Link relation");
    relations.push(...decoded.split(/\s+/u));
  }
  const relevant = relations
    .map((relation) => relation.toLowerCase())
    .filter((relation): relation is LinkRelation => relation === "next" || relation === "prev");
  if (relevant.length === 0) return null;
  const target = /^<([^>]*)>$/u.exec(parts[0] ?? "")?.[1];
  if (target === undefined || new Set(relevant).size !== relevant.length) throw new TypeError("invalid Link value");
  return { target, relations: relevant };
};

const display = (value: string | null | undefined): string | null =>
  value === undefined || value === null || value.length === 0 ? null : value;

export class GitHubClient {
  readonly #baseOrigin: string;
  readonly #baseUrl: string;
  readonly #fetch: GitHubFetch;
  readonly #timeoutMilliseconds: number;
  readonly #now: () => number;
  readonly #deadlineNow: () => number;
  readonly #deadlineSignal: (milliseconds: number) => AbortSignal;

  constructor(options: GitHubClientOptions = {}) {
    const base = new URL(options.baseUrl ?? GITHUB_ORIGIN);
    if (
      !/^https?:$/u.test(base.protocol) ||
      base.username ||
      base.password ||
      base.pathname !== "/" ||
      base.search ||
      base.hash
    ) {
      throw new TypeError("invalid GitHub test origin");
    }
    const timeout = options.timeoutMilliseconds ?? GITHUB_DEADLINE_MILLISECONDS;
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new TypeError("invalid GitHub deadline");
    this.#baseOrigin = base.origin;
    this.#baseUrl = base.origin;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMilliseconds = timeout;
    this.#now = options.now ?? Date.now;
    this.#deadlineNow = options.deadlineNow ?? performance.now.bind(performance);
    this.#deadlineSignal = options.deadlineSignal ?? AbortSignal.timeout;
  }

  async getOwner(owner: string, callerSignal?: AbortSignal): Promise<GitHubOwner> {
    const url = new URL(`/users/${encodeURIComponent(owner)}`, this.#baseUrl);
    const result = await this.#getJson(url, RawGitHubOwnerSchema, "", callerSignal);
    return this.#project(result, () => this.#owner(result.data));
  }

  async listOwnerRepositories(
    owner: string,
    limit: number,
    page: number,
    callerSignal?: AbortSignal,
  ): Promise<NumberedPage<GitHubRepositorySummary>> {
    const url = new URL(`/users/${encodeURIComponent(owner)}/repos`, this.#baseUrl);
    url.searchParams.set("type", "owner");
    url.searchParams.set("sort", "full_name");
    url.searchParams.set("direction", "asc");
    url.searchParams.set("per_page", String(limit));
    if (page !== 1) url.searchParams.set("page", String(page));
    const result = await this.#getJson(url, RawGitHubRepositoryPageSchema, "/repos", callerSignal);
    return this.#project(result, () => {
      if (result.data.length > limit) throw this.#upstream();
      const links = this.#numberedLinks(result.headers, {
        currentPage: page,
        expectedPath: url.pathname,
        fixed: { type: "owner", sort: "full_name", direction: "asc" },
        limit,
        suffix: "/repos",
      });
      if (result.data.length === 0 && links.nextPage !== null) throw this.#upstream();
      return { items: result.data.map((value) => this.#repositorySummary(value)), ...links };
    });
  }

  async getRepository(owner: string, repo: string, callerSignal?: AbortSignal): Promise<GitHubRepository> {
    this.#guardRepository(repo);
    const url = new URL(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, this.#baseUrl);
    const result = await this.#getJson(url, RawGitHubRepositorySchema, "", callerSignal);
    return this.#project(result, () => this.#repository(result.data));
  }

  async listRepositoryActivity(
    owner: string,
    repo: string,
    limit: number,
    cursor: ActivityCursor | undefined,
    callerSignal?: AbortSignal,
  ): Promise<ActivityPage> {
    this.#guardRepository(repo);
    const url = new URL(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/activity`, this.#baseUrl);
    url.searchParams.set("direction", "desc");
    url.searchParams.set("per_page", String(limit));
    if (cursor !== undefined) url.searchParams.set(cursor.direction, cursor.value);
    const result = await this.#getJson(url, RawGitHubActivityPageSchema, "/activity", callerSignal);
    return this.#project(result, () => {
      if (result.data.length > limit) throw this.#upstream();
      const links = this.#activityLinks(result.headers, url.pathname, limit, cursor);
      if (result.data.length === 0 && links.nextCursor !== null) throw this.#upstream();
      return { activities: result.data.map((value) => this.#activity(value)), ...links };
    });
  }

  async listRepositoryLanguages(owner: string, repo: string, callerSignal?: AbortSignal): Promise<GitHubLanguage[]> {
    this.#guardRepository(repo);
    const url = new URL(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/languages`, this.#baseUrl);
    const result = await this.#getJson(url, RawGitHubLanguagesSchema, "/languages", callerSignal);
    return this.#project(result, () =>
      Object.entries(result.data)
        .map(([name, bytes]) => ({ name, bytes }))
        .toSorted((left, right) => right.bytes - left.bytes || scalarCompare(left.name, right.name)),
    );
  }

  async listRepositoryTags(
    owner: string,
    repo: string,
    limit: number,
    page: number,
    callerSignal?: AbortSignal,
  ): Promise<NumberedPage<GitHubTag>> {
    this.#guardRepository(repo);
    const url = new URL(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tags`, this.#baseUrl);
    url.searchParams.set("per_page", String(limit));
    if (page !== 1) url.searchParams.set("page", String(page));
    const result = await this.#getJson(url, RawGitHubTagPageSchema, "/tags", callerSignal);
    return this.#project(result, () => {
      if (result.data.length > limit) throw this.#upstream();
      const links = this.#numberedLinks(result.headers, {
        currentPage: page,
        expectedPath: url.pathname,
        fixed: {},
        limit,
        suffix: "/tags",
      });
      if (result.data.length === 0 && links.nextPage !== null) throw this.#upstream();
      return {
        items: result.data.map((value) => ({ name: value.name, commit: { sha: value.commit.sha } })),
        ...links,
      };
    });
  }

  async #getJson<Output>(
    initialUrl: URL,
    schema: z.ZodType<Output>,
    redirectSuffix: RedirectSuffix,
    callerSignal?: AbortSignal,
  ): Promise<GitHubJsonResult<Output>> {
    const startedAt = this.#deadlineNow();
    if (!Number.isFinite(startedAt)) throw new TypeError("invalid GitHub deadline clock");
    const expiresAt = startedAt + this.#timeoutMilliseconds;
    const deadline = this.#deadlineSignal(this.#timeoutMilliseconds);
    const signal = callerSignal === undefined ? deadline : AbortSignal.any([callerSignal, deadline]);
    const response = await this.#requestWithRedirects(
      initialUrl,
      initialUrl,
      redirectSuffix,
      signal,
      callerSignal,
      deadline,
      expiresAt,
      new Set(),
      0,
    );
    if (response.status !== 200) {
      await this.#discard(response, signal, callerSignal, deadline, expiresAt);
      throw this.#statusError(response.status, response.headers);
    }
    const contentType = response.headers.get("Content-Type");
    if (contentType === null || !validJsonMediaType(contentType)) {
      await this.#discard(response, signal, callerSignal, deadline, expiresAt);
      throw this.#upstream();
    }
    const bytes = await this.#readBounded(response, signal, callerSignal, deadline, expiresAt);
    let value: unknown;
    try {
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new SyntaxError("BOM");
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      assertStrictJsonText(text);
      value = JSON.parse(text);
    } catch {
      this.#throwIfAborted(callerSignal, deadline, expiresAt);
      throw this.#upstream();
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      this.#throwIfAborted(callerSignal, deadline, expiresAt);
      throw this.#upstream();
    }
    this.#throwIfAborted(callerSignal, deadline, expiresAt);
    return {
      data: parsed.data,
      headers: response.headers,
      assertActive: () => this.#throwIfAborted(callerSignal, deadline, expiresAt),
    };
  }

  #project<T>(result: GitHubJsonResult<unknown>, projection: () => T): T {
    let projected: T;
    try {
      projected = projection();
    } catch (error) {
      result.assertActive();
      throw error;
    }
    result.assertActive();
    return projected;
  }

  async #requestWithRedirects(
    initialUrl: URL,
    currentUrl: URL,
    redirectSuffix: RedirectSuffix,
    signal: AbortSignal,
    callerSignal: AbortSignal | undefined,
    deadline: AbortSignal,
    expiresAt: number,
    visited: Set<string>,
    count: number,
  ): Promise<Response> {
    this.#throwIfAborted(callerSignal, deadline, expiresAt);
    if (visited.has(currentUrl.href)) throw this.#upstream();
    visited.add(currentUrl.href);
    let response: Response;
    try {
      response = await awaitWithSignal(
        this.#fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal,
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
            "User-Agent": "hono-playground",
            "Accept-Encoding": "identity",
          },
        }),
        signal,
      );
    } catch (error) {
      this.#requestFailure(error, callerSignal, deadline, expiresAt);
    }
    this.#throwIfAborted(callerSignal, deadline, expiresAt);
    await this.#validateEncoding(response, signal, callerSignal, deadline, expiresAt);
    if (!REDIRECT_STATUS.has(response.status)) return response;
    await this.#discard(response, signal, callerSignal, deadline, expiresAt);
    if (count >= MAX_REDIRECTS) throw this.#upstream();
    const location = response.headers.get("Location");
    if (location === null || location.includes(",")) throw this.#upstream();
    let target: URL;
    try {
      target = new URL(location, currentUrl);
    } catch {
      throw this.#upstream();
    }
    this.#validateRedirect(initialUrl, target, redirectSuffix);
    return this.#requestWithRedirects(
      initialUrl,
      target,
      redirectSuffix,
      signal,
      callerSignal,
      deadline,
      expiresAt,
      visited,
      count + 1,
    );
  }

  async #validateEncoding(
    response: Response,
    signal: AbortSignal,
    callerSignal: AbortSignal | undefined,
    deadline: AbortSignal,
    expiresAt: number,
  ): Promise<void> {
    const encoding = response.headers.get("Content-Encoding");
    if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
      await this.#discard(response, signal, callerSignal, deadline, expiresAt);
      throw this.#upstream();
    }
    this.#throwIfAborted(callerSignal, deadline, expiresAt);
  }

  #validateRedirect(initial: URL, target: URL, suffix: RedirectSuffix): void {
    if (target.origin !== this.#baseOrigin || target.username || target.password || target.hash) throw this.#upstream();
    const prefix = initial.pathname.startsWith("/users/") ? "/user/" : "/repositories/";
    if (target.pathname !== initial.pathname) {
      const id = new RegExp(`^${prefix}([0-9]+)${suffix}$`, "u").exec(target.pathname)?.[1];
      if (id === undefined || canonicalSafeInteger(id) === null) throw this.#upstream();
    }
    if (!this.#sameQuery(initial, target)) throw this.#upstream();
  }

  async #readBounded(
    response: Response,
    signal: AbortSignal,
    callerSignal: AbortSignal | undefined,
    deadline: AbortSignal,
    expiresAt: number,
  ): Promise<Uint8Array> {
    const declared = response.headers.get("Content-Length");
    if (declared !== null && !declared.includes(",")) {
      const length = canonicalSafeInteger(declared);
      if (length !== null && length > MAX_RESPONSE_BYTES) {
        await this.#discard(response, signal, callerSignal, deadline, expiresAt);
        throw this.#upstream();
      }
    }
    const reader = response.body?.getReader();
    if (reader === undefined) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const result = await awaitWithSignal(reader.read(), signal);
        this.#throwIfAborted(callerSignal, deadline, expiresAt);
        if (result.done) break;
        size += result.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          void reader.cancel().catch(() => undefined);
          throw this.#upstream();
        }
        chunks.push(result.value);
      }
    } catch (error) {
      if (signal.aborted) void reader.cancel(signal.reason).catch(() => undefined);
      if (error instanceof AppError && !signal.aborted && !this.#deadlineExpired(deadline, expiresAt)) throw error;
      this.#requestFailure(error, callerSignal, deadline, expiresAt);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  async #discard(
    response: Response,
    signal: AbortSignal,
    callerSignal: AbortSignal | undefined,
    deadline: AbortSignal,
    expiresAt: number,
  ): Promise<void> {
    try {
      const cancellation = response.body?.cancel();
      if (cancellation !== undefined) await awaitWithSignal(cancellation, signal);
    } catch (error) {
      this.#requestFailure(error, callerSignal, deadline, expiresAt);
    }
    this.#throwIfAborted(callerSignal, deadline, expiresAt);
  }

  #requestFailure(
    error: unknown,
    callerSignal: AbortSignal | undefined,
    deadline: AbortSignal,
    expiresAt: number,
  ): never {
    if (callerSignal?.aborted === true) throw callerSignal.reason ?? error;
    if (this.#deadlineExpired(deadline, expiresAt)) {
      throw new AppError({ code: "github_timeout", operatorCode: "github_transport_failure" });
    }
    throw new AppError({ code: "github_upstream", operatorCode: "github_transport_failure" });
  }

  #deadlineExpired(deadline: AbortSignal, expiresAt: number): boolean {
    return deadline.aborted || this.#deadlineNow() >= expiresAt;
  }

  #throwIfAborted(callerSignal: AbortSignal | undefined, deadline: AbortSignal, expiresAt: number): void {
    if (callerSignal?.aborted === true) throw callerSignal.reason ?? new DOMException("Aborted", "AbortError");
    if (this.#deadlineExpired(deadline, expiresAt)) {
      throw new AppError({ code: "github_timeout", operatorCode: "github_transport_failure" });
    }
  }

  #statusError(status: number, headers: Headers): AppError {
    if (status === 404) return new AppError({ code: "github_not_found" });
    if (status === 403 || status === 429) {
      const nowSeconds = this.#now() / 1_000;
      const reset = this.#quotaValue(headers, "X-RateLimit-Reset");
      const usableReset = reset !== null && reset > nowSeconds ? String(reset) : undefined;
      const retry = this.#quotaValue(headers, "Retry-After");
      const retryAfter =
        retry !== null
          ? String(retry)
          : usableReset === undefined
            ? "60"
            : String(Math.max(1, Math.ceil(Number(usableReset) - nowSeconds)));
      return new AppError({
        code: "github_rate_limit",
        headers: {
          "Retry-After": retryAfter,
          ...(usableReset === undefined ? {} : { "X-RateLimit-Reset": usableReset }),
        },
      });
    }
    return this.#upstream();
  }

  #quotaValue(headers: Headers, name: string): number | null {
    const value = headers.get(name);
    return value === null || value.includes(",") ? null : canonicalSafeInteger(value);
  }

  #relevantLinks(headers: Headers): Map<LinkRelation, URL> {
    const result = new Map<LinkRelation, URL>();
    const field = headers.get("Link");
    if (field === null) return result;
    for (const value of splitLinkValues(field)) {
      let parsed: RelevantLink | null;
      try {
        parsed = parseRelevantLink(value);
      } catch {
        throw this.#upstream();
      }
      if (parsed === null) continue;
      if (parsed.relations.some((relation) => result.has(relation))) throw this.#upstream();
      let target: URL;
      try {
        target = new URL(parsed.target);
      } catch {
        throw this.#upstream();
      }
      for (const relation of parsed.relations) result.set(relation, target);
    }
    return result;
  }

  #numberedLinks(
    headers: Headers,
    context: Readonly<{
      currentPage: number;
      expectedPath: string;
      fixed: Readonly<Record<string, string>>;
      limit: number;
      suffix: "/repos" | "/tags";
    }>,
  ): { nextPage: number | null; prevPage: number | null } {
    const links = this.#relevantLinks(headers);
    const read = (relation: LinkRelation): number | null => {
      const target = links.get(relation);
      if (target === undefined) return null;
      this.#validateLinkOrigin(target);
      if (!this.#allowedNumericPath(target.pathname, context.expectedPath, context.suffix)) throw this.#upstream();
      const pages = target.searchParams.getAll("page");
      if (pages.length !== 1) throw this.#upstream();
      const page = canonicalSafeInteger(pages[0] ?? "");
      if (page === null || page < 1) throw this.#upstream();
      target.searchParams.delete("page");
      const expected = new Map(Object.entries(context.fixed));
      expected.set("per_page", String(context.limit));
      if (!this.#exactQuery(target, expected)) throw this.#upstream();
      if (
        (relation === "next" && page <= context.currentPage) ||
        (relation === "prev" && page >= context.currentPage)
      ) {
        throw this.#upstream();
      }
      return page;
    };
    return { nextPage: read("next"), prevPage: read("prev") };
  }

  #activityLinks(
    headers: Headers,
    expectedPath: string,
    limit: number,
    current: ActivityCursor | undefined,
  ): { nextCursor: string | null; prevCursor: string | null } {
    const links = this.#relevantLinks(headers);
    const read = (relation: LinkRelation): string | null => {
      const target = links.get(relation);
      if (target === undefined) return null;
      if (relation === "prev" && current === undefined) throw this.#upstream();
      this.#validateLinkOrigin(target);
      if (!this.#allowedNumericPath(target.pathname, expectedPath, "/activity")) throw this.#upstream();
      const parameter = relation === "next" ? "after" : "before";
      const opposite = relation === "next" ? "before" : "after";
      const values = target.searchParams.getAll(parameter);
      if (values.length !== 1 || target.searchParams.has(opposite)) throw this.#upstream();
      const value = values[0] ?? "";
      if (value.length === 0 || value.length > 2_048 || !/^[!-~]+$/u.test(value)) throw this.#upstream();
      target.searchParams.delete(parameter);
      if (
        !this.#exactQuery(
          target,
          new Map([
            ["direction", "desc"],
            ["per_page", String(limit)],
          ]),
        )
      ) {
        throw this.#upstream();
      }
      if (current?.direction === parameter && current.value === value) throw this.#upstream();
      return value;
    };
    return { nextCursor: read("next"), prevCursor: read("prev") };
  }

  #validateLinkOrigin(target: URL): void {
    if (target.origin !== this.#baseOrigin || target.username || target.password || target.hash) throw this.#upstream();
  }

  #allowedNumericPath(path: string, namedPath: string, suffix: string): boolean {
    if (path === namedPath) return true;
    const prefix = suffix === "/repos" ? "/user/" : "/repositories/";
    const id = new RegExp(`^${prefix}([0-9]+)${suffix}$`, "u").exec(path)?.[1];
    return id !== undefined && canonicalSafeInteger(id) !== null;
  }

  #exactQuery(url: URL, expected: ReadonlyMap<string, string>): boolean {
    if ([...url.searchParams.keys()].length !== expected.size) return false;
    return [...expected].every(([name, value]) => {
      const values = url.searchParams.getAll(name);
      return values.length === 1 && values[0] === value;
    });
  }

  #sameQuery(left: URL, right: URL): boolean {
    const entries = (url: URL): [string, string][] =>
      [...url.searchParams.entries()].toSorted(([leftName, leftValue], [rightName, rightValue]) => {
        const names = scalarCompare(leftName, rightName);
        return names === 0 ? scalarCompare(leftValue, rightValue) : names;
      });
    return JSON.stringify(entries(left)) === JSON.stringify(entries(right));
  }

  #guardRepository(repo: string): void {
    if (/^\.+$/u.test(repo)) throw this.#upstream();
  }

  #owner(raw: RawGitHubOwner): GitHubOwner {
    return {
      id: raw.id,
      login: raw.login,
      type: raw.type,
      name: display(raw.name),
      avatarUrl: raw.avatar_url,
      htmlUrl: raw.html_url,
      company: display(raw.company),
      blog: display(raw.blog),
      location: display(raw.location),
      bio: display(raw.bio),
      publicRepos: raw.public_repos,
      followers: raw.followers,
      following: raw.following,
      createdAt: canonicalProviderTimestamp(raw.created_at) ?? "",
      updatedAt: canonicalProviderTimestamp(raw.updated_at) ?? "",
    };
  }

  #repositorySummary(raw: RawGitHubRepositorySummary): GitHubRepositorySummary {
    return {
      id: raw.id,
      name: raw.name,
      fullName: raw.full_name,
      description: display(raw.description),
      htmlUrl: raw.html_url,
      fork: raw.fork,
    };
  }

  #repository(raw: RawGitHubRepository): GitHubRepository {
    const license = raw.license?.spdx_id;
    return {
      ...this.#repositorySummary(raw),
      language: raw.language,
      stargazersCount: raw.stargazers_count,
      forksCount: raw.forks_count,
      openIssuesCount: raw.open_issues_count,
      archived: raw.archived,
      createdAt: canonicalProviderTimestamp(raw.created_at) ?? "",
      updatedAt: canonicalProviderTimestamp(raw.updated_at) ?? "",
      pushedAt: raw.pushed_at === null ? null : (canonicalProviderTimestamp(raw.pushed_at) ?? ""),
      defaultBranch: raw.default_branch,
      license:
        license === undefined || license === null || license.length === 0 || license === "NOASSERTION" ? null : license,
      topics: (raw.topics ?? []).toSorted(scalarCompare),
      disabled: raw.disabled,
    };
  }

  #activity(raw: RawGitHubActivity): GitHubActivity {
    return {
      id: raw.id,
      actor: raw.actor?.login ?? null,
      actorAvatarUrl: raw.actor?.avatar_url ?? null,
      ref: raw.ref,
      timestamp: canonicalProviderTimestamp(raw.timestamp) ?? "",
      activityType: raw.activity_type,
    };
  }

  #upstream(): AppError {
    return new AppError({ code: "github_upstream", operatorCode: "github_transport_failure" });
  }
}

export const GITHUB_TRANSPORT_LIMITS = Object.freeze({
  origin: GITHUB_ORIGIN,
  apiVersion: GITHUB_API_VERSION,
  deadlineMilliseconds: GITHUB_DEADLINE_MILLISECONDS,
  maximumResponseBytes: MAX_RESPONSE_BYTES,
});
