// Loads apps/server/.env (if present) before config is read. Must be the first import.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file; rely on the real environment.
}
