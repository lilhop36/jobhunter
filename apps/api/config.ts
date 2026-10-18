/**
 * API configuration (SRS 3.4; ENG-017).
 *
 * Parsed once at process start and rejected as a whole if it is wrong, mirroring the
 * worker's composition root: a process that has already bound a port is harder to notice
 * than one that refuses to start.
 */
export interface ApiConfig {
  databaseUrl: string;
  /**
   * Interface to bind. Defaults to 127.0.0.1: the SRS specifies no authentication for the
   * API, so it stays on the loopback interface rather than becoming a network service.
   */
  host: string;
  port: number;
}

/** Raised for configuration that would make the API unsafe or unstartable. */
export class ApiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiConfigError';
  }
}

function requiredString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ApiConfigError(`${name} is required`);
  return value;
}

function optionalString(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value ? value : fallback;
}

function optionalPort(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ApiConfigError(`${name} must be an integer between 1 and 65535; received "${raw}"`);
  }
  return value;
}

/** Build the API configuration from the environment, or throw `ApiConfigError`. */
export function parseApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    databaseUrl: requiredString(env, 'DATABASE_URL'),
    host: optionalString(env, 'API_HOST', '127.0.0.1'),
    port: optionalPort(env, 'API_PORT', 3001),
  };
}
