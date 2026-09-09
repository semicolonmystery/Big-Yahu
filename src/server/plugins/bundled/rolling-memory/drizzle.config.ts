import { defineConfig } from 'drizzle-kit';

/**
 * The plugin keeps its own database and therefore its own migrations, generated
 * into ./drizzle and applied by the plugin itself on first use. Nothing here is
 * read at runtime — it exists so `drizzle-kit generate` can be pointed at it.
 */
export default defineConfig({
  schema: './src/server/plugins/bundled/rolling-memory/schema.ts',
  out: './src/server/plugins/bundled/rolling-memory/drizzle',
  dialect: 'sqlite',
});
