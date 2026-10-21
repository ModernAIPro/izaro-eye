/**
 * Expands {{secret:NAME}} (and the older {{env:NAME}}) placeholders so
 * passwords live in the server environment, never in scenarios or the database.
 */
export function expand(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\{\{(?:secret|env):([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_, name: string) => {
    const v = env[name];
    if (v === undefined) throw new Error(`Secret ${name} is not set in the server environment`);
    return v;
  });
}
