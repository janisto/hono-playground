const ABSOLUTE_URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const HTTP_URI_PREFIX = /^https?:\/\//iu;
const PCT_ENCODED = "%[0-9A-Fa-f]{2}";
const UNRESERVED = "[A-Za-z0-9._~-]";
const SUB_DELIMITER = "[!$&'()*+,;=]";
const PCHAR = `(?:${UNRESERVED}|${PCT_ENCODED}|${SUB_DELIMITER}|[:@])`;
const SEGMENT = new RegExp(`^(?:${PCHAR})*$`, "u");
const SEGMENT_WITHOUT_COLON = new RegExp(`^(?:${UNRESERVED}|${PCT_ENCODED}|${SUB_DELIMITER}|@)+$`, "u");
const QUERY_OR_FRAGMENT = new RegExp(`^(?:${PCHAR}|[/?])*$`, "u");
const USER_INFO = new RegExp(`^(?:${UNRESERVED}|${PCT_ENCODED}|${SUB_DELIMITER}|:)*$`, "u");
const REGISTERED_NAME = new RegExp(`^(?:${UNRESERVED}|${PCT_ENCODED}|${SUB_DELIMITER})*$`, "u");
const PORT = /^[0-9]*$/u;
const IPV_FUTURE = new RegExp(`^v[0-9A-Fa-f]+\\.(?:${UNRESERVED}|${SUB_DELIMITER}|:)+$`, "iu");

const hasValidSegments = (path: string): boolean => path.split("/").every((segment) => SEGMENT.test(segment));

const isAuthority = (value: string): boolean => {
  const userInfoEnd = value.lastIndexOf("@");
  if (userInfoEnd >= 0 && !USER_INFO.test(value.slice(0, userInfoEnd))) return false;

  const hostAndPort = value.slice(userInfoEnd + 1);
  if (hostAndPort.startsWith("[")) {
    const hostEnd = hostAndPort.indexOf("]");
    if (hostEnd < 0) return false;

    const literal = hostAndPort.slice(1, hostEnd);
    const suffix = hostAndPort.slice(hostEnd + 1);
    const validLiteral = IPV_FUTURE.test(literal) || URL.canParse(`http://[${literal}]/`);
    return validLiteral && (suffix === "" || (suffix.startsWith(":") && PORT.test(suffix.slice(1))));
  }

  if (hostAndPort.includes("[") || hostAndPort.includes("]")) return false;
  const portStart = hostAndPort.lastIndexOf(":");
  const host = portStart < 0 ? hostAndPort : hostAndPort.slice(0, portStart);
  const port = portStart < 0 ? undefined : hostAndPort.slice(portStart + 1);
  return !host.includes(":") && REGISTERED_NAME.test(host) && (port === undefined || PORT.test(port));
};

const isHierarchicalPart = (value: string, absolute: boolean): boolean => {
  if (value.startsWith("//")) {
    const pathStart = value.indexOf("/", 2);
    const authority = pathStart < 0 ? value.slice(2) : value.slice(2, pathStart);
    const path = pathStart < 0 ? "" : value.slice(pathStart);
    return isAuthority(authority) && hasValidSegments(path);
  }

  if (value.startsWith("/")) return !value.startsWith("//") && hasValidSegments(value);
  if (value === "") return true;
  if (!hasValidSegments(value)) return false;
  return absolute || SEGMENT_WITHOUT_COLON.test(value.split("/", 1)[0] ?? "");
};

export const isUriReference = (value: string): boolean => {
  const fragmentStart = value.indexOf("#");
  const withoutFragment = fragmentStart < 0 ? value : value.slice(0, fragmentStart);
  const fragment = fragmentStart < 0 ? undefined : value.slice(fragmentStart + 1);
  if (fragment !== undefined && !QUERY_OR_FRAGMENT.test(fragment)) return false;

  const queryStart = withoutFragment.indexOf("?");
  const hierarchical = queryStart < 0 ? withoutFragment : withoutFragment.slice(0, queryStart);
  const query = queryStart < 0 ? undefined : withoutFragment.slice(queryStart + 1);
  if (query !== undefined && !QUERY_OR_FRAGMENT.test(query)) return false;

  const scheme = ABSOLUTE_URI_SCHEME.exec(hierarchical);
  return isHierarchicalPart(scheme === null ? hierarchical : hierarchical.slice(scheme[0].length), scheme !== null);
};

export const isAbsoluteUri = (value: string): boolean => ABSOLUTE_URI_SCHEME.test(value) && isUriReference(value);

export const isAbsoluteHttpUri = (value: string): boolean => {
  if (!HTTP_URI_PREFIX.test(value) || !isAbsoluteUri(value)) return false;

  const authorityStart = value.indexOf("//") + 2;
  const remainder = value.slice(authorityStart);
  const authorityEnd = remainder.search(/[/?#]/u);
  const authority = authorityEnd < 0 ? remainder : remainder.slice(0, authorityEnd);
  const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostAndPort.startsWith("[")) return hostAndPort.indexOf("]") > 1;

  const portStart = hostAndPort.lastIndexOf(":");
  const host = portStart < 0 ? hostAndPort : hostAndPort.slice(0, portStart);
  return host.length > 0;
};
