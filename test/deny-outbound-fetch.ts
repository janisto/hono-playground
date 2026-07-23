import { afterEach, beforeEach, vi } from "vitest";

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected outbound fetch"));
});

afterEach(() => {
  fetchSpy.mockRestore();
});
