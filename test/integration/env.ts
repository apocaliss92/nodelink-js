export function getEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length ? v : undefined;
}

export function hasIntegrationEnv(): boolean {
  return Boolean(getEnv("REOLINK_HOST") && getEnv("REOLINK_USER") && getEnv("REOLINK_PASS"));
}

