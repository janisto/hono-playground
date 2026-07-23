import { requireHmacSecret } from "./config.js";

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const hmacSha256 = async (
  secretValue: string | undefined,
  value: string,
): Promise<string> => {
  const secret = requireHmacSecret(secretValue);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
};

export const auditPseudonym = async (
  secretValue: string | undefined,
  subject: string,
): Promise<string | undefined> => {
  if (secretValue === undefined) return undefined;
  return (await hmacSha256(secretValue, subject)).slice(0, 32);
};
