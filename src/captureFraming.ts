import type { BrowserContext } from "playwright-core";

/** Match the desktop's framing exception while preserving every other CSP directive. */
export function captureFrameHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "x-frame-options") continue;
    if (name.toLowerCase() !== "content-security-policy") {
      result[name] = value;
      continue;
    }
    const policies = value.split(",").map(policy => policy.split(";")
      .map(directive => directive.trim())
      .filter(directive => directive && !/^frame-ancestors(?:\s|$)/i.test(directive))
      .join("; ")).filter(Boolean).join(", ");
    if (policies) result[name] = policies;
  }
  return result;
}

/** Only the disposable screenshot context relaxes subframe document responses. */
export async function allowCaptureFraming(context: BrowserContext): Promise<void> {
  await context.route("**/*", async route => {
    const request = route.request();
    if (!request.isNavigationRequest() || !request.frame().parentFrame()) {
      await route.fallback();
      return;
    }
    // Playwright does not route subsequent requests in a browser-followed redirect chain.
    // Fetch through the chain here so the final document's headers are relaxed too.
    const response = await route.fetch();
    try {
      await route.fulfill({ response, headers: captureFrameHeaders(response.headers()) });
    } finally {
      await response.dispose();
    }
  });
}
