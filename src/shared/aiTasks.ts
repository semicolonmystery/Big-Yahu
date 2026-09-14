/**
 * The jobs the bot hands to a model, each with its own ordered model list.
 *
 * What a task needs decides which models may go on its list: one that cannot
 * call tools is no use for the reply, and one without JSON mode is no use for
 * anything whose answer is read by code rather than by people.
 */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['none', 'low', 'medium', 'high'];

export interface AiTaskDefinition {
  id: string;
  label: string;
  description: string;
  /** Sent pictures while vision is on. */
  usesImages: boolean;
  /** Offered tools, so every model on the list has to support them. */
  usesTools: boolean;
  /** Answers are read by code, so they are asked for in JSON mode. */
  structured: boolean;
}

export const BUILT_IN_AI_TASKS: readonly AiTaskDefinition[] = [
  {
    id: 'reply',
    label: 'Reply',
    description: 'Writes the answer when someone tags the bot, calling tools as it goes.',
    usesImages: true,
    usesTools: true,
    structured: false,
  },
  {
    id: 'topicExtraction',
    label: 'Topic extraction',
    description: 'Works out what a mention is about, and what to search memory for, before the reply is written.',
    usesImages: false,
    usesTools: false,
    structured: true,
  },
  {
    id: 'factExtraction',
    label: 'Fact extraction',
    description: 'Reads each channel on a timer and decides what is worth remembering.',
    usesImages: true,
    usesTools: false,
    structured: true,
  },
  {
    id: 'plugins',
    label: 'Plugins',
    description: 'The shared list every plugin uses unless it has been given lists of its own.',
    usesImages: false,
    usesTools: false,
    structured: true,
  },
];

/** What every built-in list starts with. */
export const DEFAULT_CHAT_MODEL = 'deepseek/deepseek-v4.1-flash';

/**
 * DeepSeek's own host: the only one serving the default model at DeepSeek's
 * off-peak prices and its $0.003 cache reads.
 */
export const DEFAULT_UPSTREAM = 'deepseek';

/** The shared list every plugin uses until the operator gives it its own. */
export const SHARED_PLUGIN_TASK = 'plugins';

/** A list belonging to one job of one plugin. */
export function pluginTaskId(pluginId: string, taskId: string): string {
  return `plugin:${pluginId}:${taskId}`;
}

export function readPluginTaskId(task: string): { pluginId: string; taskId: string } | null {
  const [prefix, pluginId, ...rest] = task.split(':');
  if (prefix !== 'plugin' || !pluginId || rest.length === 0) return null;
  return { pluginId, taskId: rest.join(':') };
}

export function builtInTask(id: string): AiTaskDefinition | undefined {
  return BUILT_IN_AI_TASKS.find((task) => task.id === id);
}

