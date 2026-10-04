/** browser_act's actions; its own module so the MCP process doesn't load playwright to list them. */
export const BROWSER_ACTIONS = [
  "click",
  "dblclick",
  "hover",
  "fill",
  "type",
  "press",
  "select",
  "check",
  "uncheck",
  "scroll",
  "drag",
  "back",
  "forward",
  "reload",
] as const;
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];
