// stdout is reserved for MCP protocol messages when running as a stdio server.
// ALWAYS log to stderr.
export const log = (...a: unknown[]) => console.error("[cx-brain]", ...a);
export const trace = (obj: Record<string, unknown>) =>
  console.error("[cx-brain:trace] " + JSON.stringify(obj));
