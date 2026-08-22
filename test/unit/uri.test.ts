import { describe, expect, it } from "vitest";

import { isAbsoluteHttpUri, isAbsoluteUri, isUriReference } from "../../src/core/uri.ts";

describe("RFC 3986 URI validation", () => {
  it.each([
    "",
    "/v1/profile",
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

  it.each([
    "https://example.test/profile",
    "HTTP://example.test:8080/profile?view=full#contact",
    "https://user:password@example.test/profile",
    "https://[2001:db8::1]/profile",
    "https://[v1.fe]/profile",
  ])("accepts the absolute HTTP URI %j", (value) => {
    expect(isAbsoluteHttpUri(value)).toBe(true);
  });

  it.each([
    "ftp://example.test/profile",
    "https:///profile",
    "https://user@:443/profile",
    "https://example.test/profile ",
    "https://example.test/profile image",
    "https://example.test/%zz",
    "https://example.test/\u0000",
  ])("rejects the malformed or non-HTTP URI %j", (value) => {
    expect(isAbsoluteHttpUri(value)).toBe(false);
  });
});
