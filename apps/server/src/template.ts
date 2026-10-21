/** Expands {{env:NAME}} placeholders so secrets live in the environment, not the database. */
export function expand(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\{\{env:([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_, name: string) => {
    const v = env[name];
    if (v === undefined) throw new Error(`Environment variable ${name} is not set`);
    return v;
  });
}
