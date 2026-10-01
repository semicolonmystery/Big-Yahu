import type { PluginTool, PluginToolContext } from '@big-yahu/plugin-sdk';
import { withDefaults, type InternetConfig } from './config';

/** Nothing here reads anything security-relevant out of model-written arguments. */

export function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const text = value.trim();
  if (!text) throw new Error(`${label} cannot be empty.`);
  if ([...text].length > maxLength) throw new Error(`${label} must be at most ${maxLength} characters.`);
  return text;
}

export function optionalWhole(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a whole number.`);
  return Math.min(max, Math.max(min, Math.round(value)));
}

const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * A bare host for a domain filter. A model that writes a whole URL where a host
 * was asked for has still said something unambiguous, so the host is taken out
 * of it rather than the call being refused over punctuation.
 */
export function optionalHost(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a host name.`);
  let text = value.trim().toLowerCase().replace(/\.$/, '');
  if (text.includes('://')) {
    try {
      text = new URL(text).hostname;
    } catch {
      throw new Error(`${label} must be a host name such as "nodejs.org".`);
    }
  }
  text = text.replace(/^www\./, '');
  if (!HOST_PATTERN.test(text) || text.length > 253) {
    throw new Error(`${label} must be a host name such as "nodejs.org".`);
  }
  return text;
}

export function config(ctx: PluginToolContext): InternetConfig {
  return withDefaults(ctx.getConfig());
}

/**
 * The engine already re-reads `enabledByConfig` immediately before the handler
 * runs, so this is the second of two checks rather than the only one — and it is
 * here so the plugin's own answer says which setting is off, rather than the
 * model being told only that something is disabled.
 *
 * It also turns every thrown error into the `{ error }` shape the reply loop
 * recognises. The engine would do that too, but it would also log a stack for
 * what is usually a page that 404ed.
 */
export function guarded(
  feature: 'enableSearch' | 'enableFetch',
  operation: PluginTool['handler'],
): PluginTool['handler'] {
  return async (args, ctx) => {
    if (!config(ctx)[feature]) {
      return { error: `That internet capability is switched off in the plugin's settings ("${feature}").` };
    }
    try {
      return await operation(args, ctx);
    } catch (error) {
      return { error: (error instanceof Error ? error.message : 'the lookup failed').slice(0, 400) };
    }
  };
}
