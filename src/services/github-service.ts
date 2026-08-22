import { AppError } from "../core/errors.ts";
import type {
  GitHubActivity,
  GitHubLanguage,
  GitHubOwner,
  GitHubRepository,
  GitHubRepositorySummary,
  GitHubTag,
} from "../models/github.ts";
import { SAFE_INTEGER_MAXIMUM } from "../models/portable.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, MAX_CURSOR_LENGTH } from "../pagination/cursor.ts";
import { type ActivityCursor, GitHubClient } from "./github-client.ts";

const OWNER_REPOSITORIES = "listGitHubOwnerRepositories";
const REPOSITORY_ACTIVITY = "listGitHubRepositoryActivity";
const REPOSITORY_TAGS = "listGitHubRepositoryTags";

type Direction = "next" | "prev";
type NumberedCursor = Readonly<{
  version: 1;
  operation: typeof OWNER_REPOSITORIES | typeof REPOSITORY_TAGS;
  direction: Direction;
  owner: string;
  repo: string | null;
  limit: number;
  page: number;
}>;
type ActivityState = Readonly<{
  version: 1;
  operation: typeof REPOSITORY_ACTIVITY;
  direction: Direction;
  owner: string;
  repo: string;
  limit: number;
  value: string;
}>;

export type PageOptions = Readonly<{ limit: number; cursor?: string }>;
export type PaginatedResult<T> = Readonly<{ items: T[]; nextCursor?: string; prevCursor?: string }>;

const invalidCursor = (): never => {
  throw new AppError({ code: "invalid_request", source: { parameter: "cursor" } });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class GitHubService {
  readonly #client: GitHubClient;

  constructor(client = new GitHubClient()) {
    this.#client = client;
  }

  getOwner(owner: string, signal?: AbortSignal): Promise<GitHubOwner> {
    return this.#client.getOwner(owner, signal);
  }

  async listOwnerRepositories(
    owner: string,
    options: PageOptions,
    signal?: AbortSignal,
  ): Promise<PaginatedResult<GitHubRepositorySummary>> {
    const page = this.#numberedPage(options.cursor, OWNER_REPOSITORIES, owner, null, options.limit);
    const result = await this.#client.listOwnerRepositories(owner, options.limit, page, signal);
    return {
      items: result.items,
      ...(result.nextPage === null
        ? {}
        : {
            nextCursor: this.#encodeNumbered(OWNER_REPOSITORIES, "next", owner, null, options.limit, result.nextPage),
          }),
      ...(result.prevPage === null
        ? {}
        : {
            prevCursor: this.#encodeNumbered(OWNER_REPOSITORIES, "prev", owner, null, options.limit, result.prevPage),
          }),
    };
  }

  getRepository(owner: string, repo: string, signal?: AbortSignal): Promise<GitHubRepository> {
    return this.#client.getRepository(owner, repo, signal);
  }

  async listRepositoryActivity(
    owner: string,
    repo: string,
    options: PageOptions,
    signal?: AbortSignal,
  ): Promise<PaginatedResult<GitHubActivity>> {
    const cursor = this.#activityCursor(options.cursor, owner, repo, options.limit);
    const result = await this.#client.listRepositoryActivity(owner, repo, options.limit, cursor, signal);
    return {
      items: result.activities,
      ...(result.nextCursor === null
        ? {}
        : { nextCursor: this.#encodeActivity("next", owner, repo, options.limit, result.nextCursor) }),
      ...(result.prevCursor === null
        ? {}
        : { prevCursor: this.#encodeActivity("prev", owner, repo, options.limit, result.prevCursor) }),
    };
  }

  listRepositoryLanguages(owner: string, repo: string, signal?: AbortSignal): Promise<GitHubLanguage[]> {
    return this.#client.listRepositoryLanguages(owner, repo, signal);
  }

  async listRepositoryTags(
    owner: string,
    repo: string,
    options: PageOptions,
    signal?: AbortSignal,
  ): Promise<PaginatedResult<GitHubTag>> {
    const page = this.#numberedPage(options.cursor, REPOSITORY_TAGS, owner, repo, options.limit);
    const result = await this.#client.listRepositoryTags(owner, repo, options.limit, page, signal);
    return {
      items: result.items,
      ...(result.nextPage === null
        ? {}
        : { nextCursor: this.#encodeNumbered(REPOSITORY_TAGS, "next", owner, repo, options.limit, result.nextPage) }),
      ...(result.prevPage === null
        ? {}
        : { prevCursor: this.#encodeNumbered(REPOSITORY_TAGS, "prev", owner, repo, options.limit, result.prevPage) }),
    };
  }

  #numberedPage(
    encoded: string | undefined,
    operation: NumberedCursor["operation"],
    owner: string,
    repo: string | null,
    limit: number,
  ): number {
    if (encoded === undefined) return 1;
    let value: unknown;
    try {
      value = decodeCursor(encoded);
    } catch (error) {
      if (error instanceof InvalidCursorError) invalidCursor();
      throw error;
    }
    if (!isRecord(value)) return invalidCursor();
    const record = value;
    const valid =
      Object.keys(record).length === 7 &&
      record["version"] === 1 &&
      record["operation"] === operation &&
      (record["direction"] === "next" || record["direction"] === "prev") &&
      record["owner"] === owner &&
      record["repo"] === repo &&
      record["limit"] === limit &&
      typeof record["page"] === "number" &&
      Number.isSafeInteger(record["page"]) &&
      record["page"] >= 1 &&
      record["page"] <= SAFE_INTEGER_MAXIMUM &&
      !(record["direction"] === "next" && record["page"] === 1);
    if (!valid) invalidCursor();
    return record["page"] as number;
  }

  #activityCursor(encoded: string | undefined, owner: string, repo: string, limit: number): ActivityCursor | undefined {
    if (encoded === undefined) return undefined;
    let value: unknown;
    try {
      value = decodeCursor(encoded);
    } catch (error) {
      if (error instanceof InvalidCursorError) invalidCursor();
      throw error;
    }
    if (!isRecord(value)) return invalidCursor();
    const record = value;
    if (
      Object.keys(record).length !== 7 ||
      record["version"] !== 1 ||
      record["operation"] !== REPOSITORY_ACTIVITY ||
      (record["direction"] !== "next" && record["direction"] !== "prev") ||
      record["owner"] !== owner ||
      record["repo"] !== repo ||
      record["limit"] !== limit ||
      typeof record["value"] !== "string" ||
      record["value"].length === 0 ||
      record["value"].length > MAX_CURSOR_LENGTH ||
      !/^[!-~]+$/u.test(record["value"])
    )
      return invalidCursor();
    return { direction: record["direction"] === "next" ? "after" : "before", value: record["value"] };
  }

  #encodeNumbered(
    operation: NumberedCursor["operation"],
    direction: Direction,
    owner: string,
    repo: string | null,
    limit: number,
    page: number,
  ): string {
    return this.#boundedCursor({ version: 1, operation, direction, owner, repo, limit, page } satisfies NumberedCursor);
  }

  #encodeActivity(direction: Direction, owner: string, repo: string, limit: number, value: string): string {
    return this.#boundedCursor({
      version: 1,
      operation: REPOSITORY_ACTIVITY,
      direction,
      owner,
      repo,
      limit,
      value,
    } satisfies ActivityState);
  }

  #boundedCursor(value: NumberedCursor | ActivityState): string {
    const encoded = encodeCursor(value);
    if (encoded.length > MAX_CURSOR_LENGTH) throw new AppError({ code: "github_upstream" });
    return encoded;
  }
}
