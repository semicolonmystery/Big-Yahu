import type {
  AiTasksOverview,
  AiUsageSummary,
  ApiResponse,
  CatalogEndpoint,
  CatalogModel,
  AppSettings,
  AuthStatus,
  ChannelPermission,
  Controller,
  DashboardStats,
  EmbeddingStatus,
  FactAuthor,
  FactPage,
  FactWithSources,
  PluginSummary,
  PromptSummary,
  PluginPanelSummary,
  PluginPageData,
  PanelView,
  PanelActionResult,
} from '@shared/types';

export const AUTH_REQUIRED_EVENT = 'big-yahu:auth-required';

function checkAuthentication(response: Response, path: string): void {
  // An incorrect login/elevation password is a form error, not session expiry.
  if (response.status === 401 && !path.startsWith('/auth/')) {
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  checkAuthentication(response, path);

  let payload: ApiResponse<T>;
  try {
    payload = (await response.json()) as ApiResponse<T>;
  } catch {
    throw new Error(`Request failed with status ${response.status}`);
  }

  if (!payload.success) throw new Error(payload.error);
  return payload.data;
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

const patch = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

const del = <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' });

export const api = {
  authStatus: () => request<AuthStatus>('/auth/status'),
  setup: (username: string, password: string) => post<{ username: string }>('/auth/setup', { username, password }),
  login: (username: string, password: string) => post<{ username: string }>('/auth/login', { username, password }),
  logout: () => post<null>('/auth/logout'),
  elevate: (password: string) => post<null>('/auth/elevate', { password }),

  stats: () => request<DashboardStats>('/stats'),
  aiUsage: () => request<AiUsageSummary>('/stats/usage'),
  searchFacts: (query: string, topK?: number) => post<FactWithSources[]>('/facts/search', { query, topK }),
  listFacts: (params: { page?: number; pageSize?: number; authorId?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.pageSize) query.set('pageSize', String(params.pageSize));
    if (params.authorId) query.set('authorId', params.authorId);
    const suffix = query.toString();
    return request<FactPage>(`/facts${suffix ? `?${suffix}` : ''}`);
  },
  factAuthors: () => request<FactAuthor[]>('/facts/authors'),
  deleteFact: (id: string) => del<{ id: string }>(`/facts/${id}`),

  // Every change answers with the whole overview, so the panel never has to
  // work out what else a change affected.
  aiTasks: () => request<AiTasksOverview>('/ai-tasks'),
  setReasoningEffort: (task: string, reasoningEffort: string) =>
    patch<AiTasksOverview>(`/ai-tasks/${task}`, { reasoningEffort }),
  addTaskModel: (task: string, model: string) => post<AiTasksOverview>(`/ai-tasks/${task}/models`, { model }),
  setTaskModelUpstream: (task: string, model: string, upstream: string) =>
    patch<AiTasksOverview>(`/ai-tasks/${task}/models`, { model, upstream }),
  reorderTaskModels: (task: string, order: string[]) => request<AiTasksOverview>(`/ai-tasks/${task}/models/order`, {
    method: 'PUT',
    body: JSON.stringify({ order }),
  }),
  // OpenRouter ids carry a slash, so the model goes in the query rather than the path.
  removeTaskModel: (task: string, model: string) =>
    del<AiTasksOverview>(`/ai-tasks/${task}/models?model=${encodeURIComponent(model)}`),
  reviveTask: (task: string) => post<AiTasksOverview>(`/ai-tasks/${task}/revive`),
  setPluginSharedModels: (pluginId: string, useSharedModels: boolean) =>
    patch<AiTasksOverview>(`/ai-tasks/plugins/${pluginId}`, { useSharedModels }),
  aiTaskCatalog: (query: string) => request<CatalogModel[]>(`/ai-tasks/catalog?q=${encodeURIComponent(query)}`),
  modelHosts: (model: string) =>
    request<CatalogEndpoint[]>(`/ai-tasks/catalog/endpoints?model=${encodeURIComponent(model)}`),

  listChannels: () => request<{ channels: ChannelPermission[]; botOnline: boolean }>('/channels'),
  updateChannel: (channelId: string, values: { canReply?: boolean; canExtract?: boolean }) =>
    patch<ChannelPermission>(`/channels/${channelId}`, values),

  listControllers: () => request<Controller[]>('/controllers'),
  addController: (userId: string, label: string) => post<Controller>('/controllers', { userId, label }),
  removeController: (userId: string) => del<{ userId: string }>(`/controllers/${userId}`),

  getSettings: () => request<AppSettings>('/settings'),
  embeddingStatus: () => request<EmbeddingStatus>('/settings/embedding'),
  startReembed: () => post<EmbeddingStatus>('/settings/embedding/reembed'),
  pauseReembed: () => post<EmbeddingStatus>('/settings/embedding/pause'),
  continueReembed: () => post<EmbeddingStatus>('/settings/embedding/continue'),
  resetReembed: () => post<EmbeddingStatus>('/settings/embedding/reset'),
  updateSettings: (values: Partial<AppSettings>) => patch<AppSettings>('/settings', values),

  listPlugins: () => request<PluginSummary[]>('/plugins'),
  updatePlugin: (id: string, values: { enabled?: boolean; config?: Record<string, unknown> }) =>
    patch<PluginSummary>(`/plugins/${id}`, values),
  // Installing over an existing id always updates it in place now — there is no overwrite flag.
  installPluginFromGit: (url: string) =>
    post<{ plugin: PluginSummary | null; updated: boolean }>('/plugins/install', { url }),
  uploadPlugin: async (file: File) => {
    const form = new FormData();
    form.append('archive', file);
    const response = await fetch('/api/plugins/upload', { method: 'POST', body: form });
    checkAuthentication(response, '/plugins/upload');
    const payload = (await response.json()) as ApiResponse<{ plugin: PluginSummary | null; updated: boolean }>;
    if (!payload.success) throw new Error(payload.error);
    return payload.data;
  },
  prompts: () => request<PromptSummary[]>('/prompts'),
  savePrompt: (id: string, body: string) =>
    request<{ id: string; override: string }>(`/prompts/${id}`, { method: 'PUT', body: JSON.stringify({ body }) }),
  resetPrompt: (id: string) => del<{ id: string; reset: boolean }>(`/prompts/${id}`),
  uploadPrompt: async (id: string, file: File) => {
    const form = new FormData();
    form.append('prompt', file);
    const response = await fetch(`/api/prompts/${id}/upload`, { method: 'POST', body: form });
    checkAuthentication(response, `/prompts/${id}/upload`);
    const payload = (await response.json()) as ApiResponse<{ id: string; override: string }>;
    if (!payload.success) throw new Error(payload.error);
    return payload.data;
  },

  uninstallPlugin: (id: string) => del<{ id: string }>(`/plugins/${id}`),
  uninstallAllPlugins: () => del<{ removed: string[] }>('/plugins'),
  reloadPlugins: () => post<PluginSummary[]>('/plugins/reload'),

  pluginEnvKeys: (id: string) => request<string[]>(`/plugins/${id}/env/keys`),
  pluginEnv: (id: string) => request<Record<string, string>>(`/plugins/${id}/env`),
  setPluginEnv: (id: string, values: Record<string, string>) =>
    request<string[]>(`/plugins/${id}/env`, { method: 'PUT', body: JSON.stringify({ values }) }),
  deletePluginEnv: (id: string, key: string) => del<{ key: string }>(`/plugins/${id}/env/${key}`),

  pluginPanels: (id: string) => request<PluginPanelSummary[]>(`/plugins/${id}/panels`),
  pluginPanel: (id: string, panelId: string) => request<PanelView>(`/plugins/${id}/panels/${panelId}`),
  runPanelAction: (id: string, panelId: string, actionId: string, values: Record<string, string>) =>
    post<PanelActionResult>(`/plugins/${id}/panels/${panelId}/actions/${actionId}`, { values }),

  pluginPage: (id: string, pageId: string, params: { page: number; pageSize: number; query: string }) => {
    const query = new URLSearchParams({
      page: String(params.page),
      pageSize: String(params.pageSize),
      query: params.query,
    });
    return request<PluginPageData>(`/plugins/${id}/pages/${pageId}?${query.toString()}`);
  },
  runPluginPageAction: (id: string, pageId: string, actionId: string, rowId: string) =>
    post<PanelActionResult>(`/plugins/${id}/pages/${pageId}/actions/${actionId}`, { rowId }),
};
