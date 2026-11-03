import indexGuide from "../../llms.txt?raw";
import fullGuide from "../../llms-full.txt?raw";

export const CATALOG_MEDIA_TYPE = 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';
export const GUIDE_MEDIA_TYPE = "text/plain; charset=utf-8";
export const INDEX_LINK = '</llms.txt>; rel="describedby"; type="text/plain"';
export const CATALOG_LINK = '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"';
export const SCHEMA_LINK = '</openapi.json>; rel="service-desc"; type="application/json"';
export const API_CATALOG = JSON.stringify({
  linkset: [
    {
      anchor: "/",
      "service-desc": [{ href: "/openapi.json", type: "application/json" }],
      "service-doc": [
        { href: "/llms.txt", type: "text/plain" },
        { href: "/llms-full.txt", type: "text/plain" },
      ],
      status: [{ href: "/health", type: "application/json" }],
    },
  ],
});
export const USAGE_GUIDES = [
  { path: "/llms.txt", content: indexGuide },
  { path: "/llms-full.txt", content: fullGuide },
] as const;
