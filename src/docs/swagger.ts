export const SWAGGER_UI_VERSION = "5.32.11";

const SWAGGER_UI_CDN_BASE = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}`;
const SWAGGER_UI_STYLESHEET_URL = `${SWAGGER_UI_CDN_BASE}/swagger-ui.css`;
const SWAGGER_UI_BUNDLE_URL = `${SWAGGER_UI_CDN_BASE}/swagger-ui-bundle.js`;

export const SWAGGER_UI_STYLESHEET_INTEGRITY =
  "sha384-9Q2fpS+xeS4ffJy6CagnwoUl+4ldAYhOs9pgZuEKxypVModhmZFzeMlvVsAjf7uT";
export const SWAGGER_UI_BUNDLE_INTEGRITY =
  "sha384-vfl/klfTFrIz5urj0HnhcXLAbzPdRHezizfy+XgFB6GqcKkhlk0lS3bIbyB39NLA";

export const SWAGGER_UI_BOOTSTRAP = `window.onload = () => {
  window.ui = SwaggerUIBundle({
    dom_id: "#swagger-ui",
    url: "/openapi.json",
    supportedSubmitMethods: [],
    validatorUrl: "none",
  });
};`;

export const SWAGGER_UI_BOOTSTRAP_CSP_SOURCE =
  "'sha256-CQSRbJsH3oggTHmvhRAccynG58ANP1v1E04cYW0LG6Y='";
export const SWAGGER_UI_BUNDLE_CSP_SOURCE = `'${SWAGGER_UI_BUNDLE_INTEGRITY}'`;

type SwaggerUiAssets = Readonly<{
  css: readonly string[];
  js: readonly string[];
}>;

export const renderSwaggerUiBody = (assets: SwaggerUiAssets): string => {
  if (
    assets.css.length !== 1 ||
    assets.css[0] !== SWAGGER_UI_STYLESHEET_URL ||
    assets.js.length !== 1 ||
    assets.js[0] !== SWAGGER_UI_BUNDLE_URL
  ) {
    throw new Error("Swagger UI asset configuration mismatch");
  }

  return `
    <div>
      <div id="swagger-ui"></div>
      <link rel="stylesheet" href="${SWAGGER_UI_STYLESHEET_URL}" integrity="${SWAGGER_UI_STYLESHEET_INTEGRITY}" crossorigin="anonymous" referrerpolicy="no-referrer" />
      <script src="${SWAGGER_UI_BUNDLE_URL}" integrity="${SWAGGER_UI_BUNDLE_INTEGRITY}" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
      <script>${SWAGGER_UI_BOOTSTRAP}</script>
    </div>
  `;
};
