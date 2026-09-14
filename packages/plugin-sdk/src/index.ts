/**
 * The Big Yahu plugin contract.
 *
 * A plugin is an ordinary Node package whose default export carries its
 * capabilities. Declare this as a devDependency: everything here except
 * `PLUGIN_API_VERSION`, `HOOK_NAMES` and `definePlugin` is a type, so a
 * production install never fetches it and nothing of it exists at runtime.
 *
 * ```ts
 * import { definePlugin } from '@big-yahu/plugin-sdk';
 *
 * export default definePlugin({
 *   id: 'my-plugin',
 *   name: 'My Plugin',
 *   description: 'What it does, in one line.',
 *   version: '1.0.0',
 *   onMessage({ message }) { ... },
 * });
 * ```
 *
 * The bot resolves identity and contract compatibility from your package.json
 * rather than from the export, and refuses to run a plugin whose declared SDK
 * major does not match `PLUGIN_API_VERSION` exactly.
 */

export { PLUGIN_API_VERSION } from './version';
export type { PluginManifest } from './version';

export type {
  Fact,
  FactMetadata,
  FactCandidate,
  PluginStorage,
  SourceMessage,
} from './data';

export { HOOK_NAMES } from './contract';

export type {
  AfterReplyContext,
  AnnotateContextContext,
  DraftImage,
  PluginAiTask,
  PluginGenerateRequest,
  PluginJsonSchema,
  PluginStructuredRequest,
  AnnotateExtractionContext,
  BeforeReplyContext,
  BeforeReplyResult,
  BigYahuPlugin,
  ContextAnnotations,
  ContextMessageRef,
  ContextUser,
  DraftPrompt,
  HookName,
  OnBotTaggedContext,
  OnHourlyCheckContext,
  OnMessageContext,
  PanelActionResult,
  PanelElement,
  PanelView,
  PluginCell,
  PluginContext,
  PluginField,
  PluginFieldType,
  PluginPage,
  PluginPageColumn,
  PluginPageData,
  PluginPageRequest,
  PluginPageRow,
  PluginPanel,
  PluginSecretField,
  PluginTool,
  PluginToolContext,
  PluginToolInvocation,
} from './contract';

import type { BigYahuPlugin } from './contract';

/**
 * Identity at runtime — it returns what you give it. What it buys you is the
 * type checker: a mistyped hook name or a handler with the wrong argument is a
 * red squiggle here rather than a plugin the bot silently declines to register
 * because the structural check found nothing it recognised.
 */
export function definePlugin(plugin: BigYahuPlugin): BigYahuPlugin {
  return plugin;
}
