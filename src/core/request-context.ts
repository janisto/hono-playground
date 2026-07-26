const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const requestId = (candidate: string | null): string =>
  candidate !== null && REQUEST_ID.test(candidate) ? candidate : crypto.randomUUID().replaceAll("-", "").toLowerCase();
