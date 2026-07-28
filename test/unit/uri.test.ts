import { describe, expect, it } from "vitest";

import { isAbsoluteUri, isUriReference } from "../../src/core/uri.ts";

describe("RFC 3986 URI validation", () => {
  it.each([
    "",
    "/v1/profiles/current",
    "../profiles/current?include=items#contact",
    "//example.test/profiles/current",
    "https://example.test/profiles/current",
    "https://user:password@example.test:8443/profiles/current",
    "https://[2001:db8::1]/profiles/current",
    "https://[v1.fe]/profiles/current",
    "https://[V1.fe]/profiles/current",
    "relative:first-segment",
    "urn:oasis:names:specification:docbook:dtd:xml:4.1.2",
  ])("accepts the URI reference %j", (value) => {
    expect(isUriReference(value)).toBe(true);
  });

  it.each([
    "invalid URI with spaces",
    "%",
    "a#b#c",
    "/a[b]",
    "1relative:first-segment",
    "https://example.test/a[b]",
    "https://[not-an-ip-literal]/",
  ])("rejects the malformed URI reference %j", (value) => {
    expect(isUriReference(value)).toBe(false);
  });

  it.each(["https://example.test/profile", "urn:example:profile", "https://[2001:db8::1]/profile"])(
    "accepts the absolute URI %j",
    (value) => {
      expect(isAbsoluteUri(value)).toBe(true);
    },
  );

  it.each(["/relative-profile", "../relative-profile", "//example.test/profile", "a#b#c"])(
    "rejects the non-absolute or malformed URI %j",
    (value) => {
      expect(isAbsoluteUri(value)).toBe(false);
    },
  );
});
