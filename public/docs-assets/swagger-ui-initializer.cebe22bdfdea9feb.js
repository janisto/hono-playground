(() => {
  "use strict";

  const noManualAuthorizationPlugin = () => ({
    wrapComponents: {
      authorizeBtn: () => () => null,
      authorizeOperationBtn: () => () => null,
    },
  });

  const mountAuthenticationNotice = () => {
    const swaggerRoot = document.querySelector("#swagger-ui");
    if (!(swaggerRoot instanceof HTMLElement)) {
      throw new Error("Swagger UI root element is missing");
    }

    const notice = document.createElement("aside");
    notice.className = "docs-auth-banner";
    notice.setAttribute("role", "note");

    const title = document.createElement("strong");
    title.textContent = "No token paste";

    const explanation = document.createElement("span");
    explanation.textContent =
      "Do not paste Cloudflare Access tokens into this page. Protected requests use only " +
      "your existing same-origin browser session. If needed, open /v1/profile in a " +
      "top-level tab and complete Access login first.";

    notice.append(title, explanation);
    swaggerRoot.before(notice);
  };

  const startSwaggerUi = () => {
    mountAuthenticationNotice();

    const SwaggerUIBundle = window.SwaggerUIBundle;
    if (typeof SwaggerUIBundle !== "function") {
      throw new Error("Swagger UI bundle failed to load");
    }

    window.ui = SwaggerUIBundle({
      url: "/openapi.json",
      dom_id: "#swagger-ui",
      deepLinking: true,
      validatorUrl: null,
      queryConfigEnabled: false,
      persistAuthorization: false,
      withCredentials: true,
      layout: "BaseLayout",
      presets: [SwaggerUIBundle.presets.apis],
      plugins: [noManualAuthorizationPlugin],
      requestInterceptor(request) {
        const target = new URL(request.url, window.location.href);
        if (target.origin !== window.location.origin) {
          throw new Error("Swagger UI blocked a cross-origin request");
        }

        request.url = target.href;
        request.credentials = "include";
        return request;
      },
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startSwaggerUi, { once: true });
  } else {
    startSwaggerUi();
  }
})();
