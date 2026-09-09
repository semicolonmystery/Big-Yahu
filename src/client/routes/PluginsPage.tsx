import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowUpRight, Lock, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { PanelElement, PanelView, PluginField, PluginPanelSummary, PluginSummary } from '@shared/types';
import { api } from '@/lib/api';
import { renderPanelElement, panelFieldValues } from '@/lib/panelElements';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';

const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const ELEVATION_EXPIRED = 'Re-enter your password to view or change secrets';

function isElevationError(err: unknown): boolean {
  return err instanceof Error && err.message === ELEVATION_EXPIRED;
}

interface ConfigEditorState {
  pluginId: string;
  text: string;
  error: string | null;
  saving: boolean;
}

/** Mirrors the server's own emptiness check in `coerceConfig`, so Save can be blocked before the round trip. */
function isFieldEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && value.length === 0);
}

function defaultFieldValue(field: PluginField): unknown {
  switch (field.type) {
    case 'boolean':
      return false;
    case 'number':
      return field.min ?? 0;
    case 'list':
      return [];
    case 'select':
      return field.options?.[0]?.value ?? '';
    default:
      return '';
  }
}

interface ConfigFormState {
  pluginId: string;
  schema: PluginField[];
  values: Record<string, unknown>;
  saving: boolean;
}

function ConfigField({
  field,
  value,
  onChange,
}: {
  field: PluginField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const requiredMark = field.required && <span className="text-destructive"> *</span>;
  const fieldId = `config-field-${field.name}`;

  if (field.type === 'boolean') {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-3">
          <Switch id={fieldId} checked={Boolean(value)} onCheckedChange={onChange} />
          <Label htmlFor={fieldId}>
            {field.label}
            {requiredMark}
          </Label>
        </div>
        {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
      </div>
    );
  }

  if (field.type === 'list') {
    const items = Array.isArray(value) ? value : [];
    const addItem = () => onChange([...items, field.itemType === 'number' ? 0 : '']);
    const removeItem = (index: number) => onChange(items.filter((_, i) => i !== index));
    const updateItem = (index: number, raw: string) => {
      const next = [...items];
      next[index] = field.itemType === 'number' ? Number(raw) : raw;
      onChange(next);
    };
    return (
      <div className="flex flex-col gap-1.5">
        <Label>
          {field.label}
          {requiredMark}
        </Label>
        <div className="flex flex-col gap-2">
          {items.map((item, index) => (
            // eslint-disable-next-line react/no-array-index-key -- rows have no identity of their own
            <div key={index} className="flex items-center gap-2">
              <Input
                type={field.itemType === 'number' ? 'number' : 'text'}
                value={String(item)}
                onChange={(event) => updateItem(index, event.target.value)}
              />
              <Button variant="ghost" size="icon-sm" aria-label="Remove item" onClick={() => removeItem(index)}>
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" className="w-fit" onClick={addItem}>
            <Plus />
            Add
          </Button>
        </div>
        {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={fieldId}>
        {field.label}
        {requiredMark}
      </Label>
      {field.type === 'text' ? (
        <Textarea
          id={fieldId}
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : field.type === 'number' ? (
        <Input
          id={fieldId}
          type="number"
          min={field.min}
          max={field.max}
          step={field.step}
          value={typeof value === 'number' ? value : ''}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
          className="max-w-xs"
        />
      ) : field.type === 'select' ? (
        <Select value={typeof value === 'string' ? value : ''} onValueChange={onChange}>
          <SelectTrigger className="w-full max-w-xs">
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={fieldId}
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
    </div>
  );
}

interface PanelDialogState {
  pluginId: string;
  panelId: string;
  title: string;
  description?: string;
  loading: boolean;
  error: string | null;
  view: PanelView | null;
  values: Record<string, string>;
  actionBusy: boolean;
  confirm: { actionId: string; text: string; tone?: 'default' | 'destructive' } | null;
}

interface SecretsState {
  pluginId: string;
  keys: string[] | null;
  keysError: string | null;
  elevated: boolean;
  password: string;
  elevating: boolean;
  elevateError: string | null;
  values: Record<string, string> | null;
  saving: boolean;
  newKey: string;
  newValue: string;
  formError: string | null;
}

export default function PluginsPage() {
  const [plugins, setPlugins] = useState<PluginSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<ConfigEditorState | null>(null);
  const [configForm, setConfigForm] = useState<ConfigFormState | null>(null);
  const [secrets, setSecrets] = useState<SecretsState | null>(null);

  const [gitUrl, setGitUrl] = useState('');
  const [installingGit, setInstallingGit] = useState(false);
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [reloading, setReloading] = useState(false);

  const [uninstallTarget, setUninstallTarget] = useState<PluginSummary | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const [removeAllOpen, setRemoveAllOpen] = useState(false);
  const [removingAll, setRemovingAll] = useState(false);

  const [panelSummaries, setPanelSummaries] = useState<Record<string, PluginPanelSummary[]>>({});
  const [panelDialog, setPanelDialog] = useState<PanelDialogState | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listPlugins()
      .then((data) => {
        if (!cancelled) setPlugins(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load plugins');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!plugins) return;
    // An incompatible plugin exposes nothing — asking it for panels would just be a 404 per row.
    const missing = plugins.filter((p) => !p.incompatibleReason && !(p.id in panelSummaries));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map((p) =>
        api
          .pluginPanels(p.id)
          .then((panels): [string, PluginPanelSummary[]] => [p.id, panels])
          .catch((): [string, PluginPanelSummary[]] => [p.id, []]),
      ),
    ).then((results) => {
      if (cancelled) return;
      setPanelSummaries((current) => {
        const next = { ...current };
        for (const [id, panels] of results) next[id] = panels;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [plugins, panelSummaries]);

  const refresh = async () => {
    const data = await api.listPlugins();
    setPlugins(data);
  };

  const handleToggle = async (plugin: PluginSummary, enabled: boolean) => {
    if (!plugins) return;
    setPlugins(plugins.map((p) => (p.id === plugin.id ? { ...p, enabled } : p)));
    try {
      await api.updatePlugin(plugin.id, { enabled });
    } catch (err) {
      setPlugins((current) =>
        (current ?? []).map((p) => (p.id === plugin.id ? { ...p, enabled: plugin.enabled } : p)),
      );
      toast.error(err instanceof Error ? err.message : `Failed to update ${plugin.name}`);
    }
  };

  // A plugin with a declared schema gets the typed form; without one it falls back to raw JSON, same as before.
  const openConfig = (plugin: PluginSummary) => {
    if (plugin.configSchema) {
      const values: Record<string, unknown> = {};
      for (const field of plugin.configSchema) {
        values[field.name] = field.name in plugin.config ? plugin.config[field.name] : defaultFieldValue(field);
      }
      setConfigForm({ pluginId: plugin.id, schema: plugin.configSchema, values, saving: false });
      return;
    }
    setEditor({ pluginId: plugin.id, text: JSON.stringify(plugin.config, null, 2), error: null, saving: false });
  };

  const handleSaveConfig = async () => {
    if (!editor || !plugins) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(editor.text) as Record<string, unknown>;
    } catch {
      setEditor({ ...editor, error: 'Invalid JSON' });
      return;
    }

    setEditor({ ...editor, saving: true, error: null });
    try {
      const updated = await api.updatePlugin(editor.pluginId, { config: parsed });
      setPlugins(plugins.map((p) => (p.id === updated.id ? updated : p)));
      toast.success('Plugin configuration saved');
      setEditor(null);
    } catch (err) {
      setEditor({ ...editor, saving: false });
      toast.error(err instanceof Error ? err.message : 'Failed to save configuration');
    }
  };

  const setConfigFormValue = (name: string, value: unknown) => {
    setConfigForm((current) => (current ? { ...current, values: { ...current.values, [name]: value } } : current));
  };

  const configFormMissing = configForm
    ? configForm.schema.filter((field) => field.required && isFieldEmpty(configForm.values[field.name]))
    : [];

  const handleSaveConfigForm = async () => {
    if (!configForm || !plugins || configFormMissing.length > 0) return;
    setConfigForm({ ...configForm, saving: true });
    try {
      const updated = await api.updatePlugin(configForm.pluginId, { config: configForm.values });
      setPlugins(plugins.map((p) => (p.id === updated.id ? updated : p)));
      toast.success('Plugin configuration saved');
      setConfigForm(null);
    } catch (err) {
      setConfigForm((current) => (current ? { ...current, saving: false } : current));
      toast.error(err instanceof Error ? err.message : 'Failed to save configuration');
    }
  };

  const handleInstallGit = async () => {
    const url = gitUrl.trim();
    if (!url) return;
    setInstallingGit(true);
    try {
      const { plugin, updated } = await api.installPluginFromGit(url);
      await refresh();
      setGitUrl('');
      toast.success(updated ? `Updated ${plugin?.name ?? url}` : `Installed ${plugin?.name ?? url}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to install plugin');
    } finally {
      setInstallingGit(false);
    }
  };

  const handleUpload = async () => {
    if (!zipFile) return;
    setUploading(true);
    try {
      const { plugin, updated } = await api.uploadPlugin(zipFile);
      await refresh();
      setZipFile(null);
      setFileInputKey((key) => key + 1);
      toast.success(updated ? `Updated ${plugin?.name ?? zipFile.name}` : `Installed ${plugin?.name ?? zipFile.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to upload plugin');
    } finally {
      setUploading(false);
    }
  };

  const handleReload = async () => {
    setReloading(true);
    try {
      const data = await api.reloadPlugins();
      setPlugins(data);
      toast.success('Plugins reloaded');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reload plugins');
    } finally {
      setReloading(false);
    }
  };

  const handleUninstall = async () => {
    if (!uninstallTarget) return;
    setUninstalling(true);
    try {
      await api.uninstallPlugin(uninstallTarget.id);
      await refresh();
      toast.success(`${uninstallTarget.name} uninstalled`);
      setUninstallTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to uninstall plugin');
    } finally {
      setUninstalling(false);
    }
  };

  const handleRemoveAll = async () => {
    setRemovingAll(true);
    try {
      await api.uninstallAllPlugins();
      await refresh();
      toast.success('All plugins removed');
      setRemoveAllOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove plugins');
    } finally {
      setRemovingAll(false);
    }
  };

  const fetchPanel = (pluginId: string, panelId: string, silent = false) => {
    if (!silent) {
      setPanelDialog((current) =>
        current && current.pluginId === pluginId && current.panelId === panelId
          ? { ...current, loading: true, error: null }
          : current,
      );
    }
    return api
      .pluginPanel(pluginId, panelId)
      .then((view) => {
        setPanelDialog((current) =>
          current && current.pluginId === pluginId && current.panelId === panelId
            ? { ...current, loading: false, error: null, view, values: panelFieldValues(view) }
            : current,
        );
      })
      .catch((err: unknown) => {
        setPanelDialog((current) =>
          current && current.pluginId === pluginId && current.panelId === panelId
            ? { ...current, loading: false, error: err instanceof Error ? err.message : 'Failed to load panel' }
            : current,
        );
      });
  };

  useEffect(() => {
    if (!panelDialog?.view?.pollSeconds) return;
    const { pluginId, panelId } = panelDialog;
    const id = window.setInterval(() => {
      void fetchPanel(pluginId, panelId, true);
    }, panelDialog.view.pollSeconds * 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelDialog?.pluginId, panelDialog?.panelId, panelDialog?.view?.pollSeconds]);

  const openPanel = (pluginId: string, panel: PluginPanelSummary) => {
    setPanelDialog({
      pluginId,
      panelId: panel.id,
      title: panel.title,
      description: panel.description,
      loading: true,
      error: null,
      view: null,
      values: {},
      actionBusy: false,
      confirm: null,
    });
    void fetchPanel(pluginId, panel.id, true);
  };

  const setPanelFieldValue = (name: string, value: string) => {
    setPanelDialog((current) => (current ? { ...current, values: { ...current.values, [name]: value } } : current));
  };

  const runPanelAction = async (actionId: string) => {
    if (!panelDialog) return;
    const { pluginId, panelId, values } = panelDialog;
    setPanelDialog((current) => (current ? { ...current, actionBusy: true, confirm: null } : current));
    try {
      const result = await api.runPanelAction(pluginId, panelId, actionId, values);
      if (result.message) {
        if (result.tone === 'error') toast.error(result.message);
        else if (result.tone === 'success') toast.success(result.message);
        else toast(result.message);
      }
      if (result.view) {
        const view = result.view;
        setPanelDialog((current) =>
          current && current.pluginId === pluginId && current.panelId === panelId
            ? { ...current, actionBusy: false, view, values: panelFieldValues(view) }
            : current,
        );
      } else {
        setPanelDialog((current) =>
          current && current.pluginId === pluginId && current.panelId === panelId
            ? { ...current, actionBusy: false }
            : current,
        );
        await fetchPanel(pluginId, panelId, true);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
      setPanelDialog((current) =>
        current && current.pluginId === pluginId && current.panelId === panelId
          ? { ...current, actionBusy: false }
          : current,
      );
    }
  };

  const handlePanelButtonClick = (el: Extract<PanelElement, { type: 'button' }>) => {
    if (el.confirm) {
      setPanelDialog((current) =>
        current ? { ...current, confirm: { actionId: el.actionId, text: el.confirm as string, tone: el.tone } } : current,
      );
      return;
    }
    void runPanelAction(el.actionId);
  };

  const openSecrets = (plugin: PluginSummary) => {
    setSecrets({
      pluginId: plugin.id,
      keys: null,
      keysError: null,
      elevated: false,
      password: '',
      elevating: false,
      elevateError: null,
      values: null,
      saving: false,
      newKey: '',
      newValue: '',
      formError: null,
    });
    api
      .pluginEnvKeys(plugin.id)
      .then((keys) =>
        setSecrets((current) => (current && current.pluginId === plugin.id ? { ...current, keys } : current)),
      )
      .catch((err: unknown) =>
        setSecrets((current) =>
          current && current.pluginId === plugin.id
            ? { ...current, keysError: err instanceof Error ? err.message : 'Failed to load secret names' }
            : current,
        ),
      );
  };

  const lockSecrets = (message: string) => {
    setSecrets((current) =>
      current
        ? { ...current, elevated: false, values: null, password: '', elevating: false, elevateError: message }
        : current,
    );
  };

  const handleElevate = async () => {
    if (!secrets || !secrets.password) return;
    setSecrets({ ...secrets, elevating: true, elevateError: null });
    try {
      await api.elevate(secrets.password);
      const values = await api.pluginEnv(secrets.pluginId);
      setSecrets((current) =>
        current
          ? { ...current, elevated: true, elevating: false, values, keys: Object.keys(values), password: '' }
          : current,
      );
    } catch (err) {
      setSecrets((current) =>
        current
          ? { ...current, elevating: false, elevateError: err instanceof Error ? err.message : 'Failed to unlock' }
          : current,
      );
    }
  };

  const handleAddSecret = () => {
    if (!secrets || !secrets.values) return;
    const key = secrets.newKey.trim();
    if (!ENV_KEY_RE.test(key)) {
      setSecrets({ ...secrets, formError: 'Use A-Z, digits and underscores, and do not start with a digit.' });
      return;
    }
    if (key in secrets.values) {
      setSecrets({ ...secrets, formError: `"${key}" already exists.` });
      return;
    }
    const declared = plugins?.find((p) => p.id === secrets.pluginId)?.secrets ?? [];
    if (declared.some((field) => field.name === key)) {
      setSecrets({ ...secrets, formError: `"${key}" is already declared above.` });
      return;
    }
    setSecrets({
      ...secrets,
      values: { ...secrets.values, [key]: secrets.newValue },
      keys: [...(secrets.keys ?? []), key],
      newKey: '',
      newValue: '',
      formError: null,
    });
  };

  const handleDeleteSecret = async (key: string) => {
    if (!secrets) return;
    try {
      await api.deletePluginEnv(secrets.pluginId, key);
      setSecrets((current) => {
        if (!current) return current;
        const values = { ...(current.values ?? {}) };
        delete values[key];
        return { ...current, values, keys: (current.keys ?? []).filter((k) => k !== key) };
      });
    } catch (err) {
      if (isElevationError(err)) {
        lockSecrets(ELEVATION_EXPIRED);
        return;
      }
      toast.error(err instanceof Error ? err.message : `Failed to delete ${key}`);
    }
  };

  const handleSaveSecrets = async () => {
    if (!secrets || !secrets.values) return;
    setSecrets({ ...secrets, saving: true, formError: null });
    try {
      const keys = await api.setPluginEnv(secrets.pluginId, secrets.values);
      setSecrets((current) => (current ? { ...current, saving: false, keys } : current));
      toast.success('Secrets saved');
    } catch (err) {
      if (isElevationError(err)) {
        lockSecrets(ELEVATION_EXPIRED);
        return;
      }
      setSecrets((current) => (current ? { ...current, saving: false } : current));
      toast.error(err instanceof Error ? err.message : 'Failed to save secrets');
    }
  };

  const panelValues = panelDialog?.values ?? {};
  const panelBusy = panelDialog?.actionBusy ?? false;
  const panelElementHandlers = {
    values: panelValues,
    onFieldChange: setPanelFieldValue,
    busy: panelBusy,
    onButtonClick: handlePanelButtonClick,
  };

  const editingPlugin = plugins?.find((p) => p.id === editor?.pluginId) ?? null;
  const configFormPlugin = plugins?.find((p) => p.id === configForm?.pluginId) ?? null;
  const secretsPlugin = plugins?.find((p) => p.id === secrets?.pluginId) ?? null;
  const secretsDeclared = secretsPlugin?.secrets ?? [];
  const secretsDeclaredNames = new Set(secretsDeclared.map((field) => field.name));
  const secretsUndeclaredKeys = (secrets?.keys ?? []).filter((key) => !secretsDeclaredNames.has(key));
  const onlyBundled = plugins !== null && plugins.length > 0 && plugins.every((p) => p.bundled);
  const showAddHint = plugins !== null && (plugins.length === 0 || onlyBundled);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Plugins</h1>
        <Button variant="outline" size="sm" onClick={() => void handleReload()} disabled={reloading}>
          <RefreshCw className={reloading ? 'animate-spin' : undefined} />
          {reloading ? 'Reloading…' : 'Reload'}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Couldn't load plugins</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Install a plugin</CardTitle>
          <CardDescription>From a public git repository, or by uploading a packaged .zip.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-end sm:gap-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="plugin-git-url">Git URL</Label>
              <Input
                id="plugin-git-url"
                value={gitUrl}
                onChange={(event) => setGitUrl(event.target.value)}
                placeholder="https://github.com/org/plugin.git"
                className="font-mono"
              />
            </div>
            <Button onClick={() => void handleInstallGit()} disabled={installingGit || !gitUrl.trim()}>
              {installingGit ? 'Installing…' : 'Install'}
            </Button>
          </div>

          <Separator />

          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-end sm:gap-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="plugin-zip">Upload .zip</Label>
              <Input
                key={fileInputKey}
                id="plugin-zip"
                type="file"
                accept=".zip"
                onChange={(event) => setZipFile(event.target.files?.[0] ?? null)}
              />
            </div>
            <Button onClick={() => void handleUpload()} disabled={uploading || !zipFile}>
              {uploading ? 'Uploading…' : 'Upload'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
        <>
          {plugins && plugins.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Hooks</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {plugins.map((plugin) => {
                  const incompatible = plugin.incompatibleReason !== null;
                  return (
                    <TableRow key={plugin.id}>
                      <TableCell className="font-medium">
                        <div className="flex flex-wrap items-center gap-2">
                          {plugin.name}
                          {plugin.bundled && <Badge variant="outline">bundled</Badge>}
                          {incompatible && <Badge variant="destructive">Incompatible</Badge>}
                          {!incompatible && plugin.apiVersion !== null && (
                            <span className="text-xs text-muted-foreground">api v{plugin.apiVersion}</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-sm whitespace-normal text-muted-foreground">
                        {plugin.description}
                        {incompatible && <p className="mt-1 text-xs text-destructive">{plugin.incompatibleReason}</p>}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{plugin.version}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {plugin.hooks.map((hook) => (
                            <Badge key={hook} variant="outline">
                              {hook}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={plugin.enabled}
                          disabled={incompatible}
                          onCheckedChange={(checked) => void handleToggle(plugin, checked)}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          {!incompatible && (
                            <>
                              <Button variant="outline" size="sm" onClick={() => openConfig(plugin)}>
                                Config
                              </Button>
                              <Button variant="outline" size="sm" onClick={() => openSecrets(plugin)}>
                                <Lock />
                                Secrets
                              </Button>
                              {(panelSummaries[plugin.id] ?? []).map((panel) => (
                                <Button
                                  key={panel.id}
                                  variant="outline"
                                  size="sm"
                                  onClick={() => openPanel(plugin.id, panel)}
                                >
                                  {panel.title}
                                </Button>
                              ))}
                              {plugin.pages.map((page) => (
                                <Button
                                  key={page.id}
                                  variant="ghost"
                                  size="sm"
                                  nativeButton={false}
                                  render={<Link to={`/plugins/${plugin.id}/${page.id}`} />}
                                >
                                  {page.title}
                                  <ArrowUpRight />
                                </Button>
                              ))}
                            </>
                          )}
                          {!plugin.bundled && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Uninstall ${plugin.name}`}
                              onClick={() => setUninstallTarget(plugin)}
                            >
                              <Trash2 />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}

          {showAddHint && (
            <p className="text-sm text-muted-foreground">
              {plugins && plugins.length === 0 ? 'No plugins installed.' : 'Only bundled plugins are installed.'} Add
              one above by git URL or .zip upload.
            </p>
          )}
        </>
      )}

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Remove all plugins</CardTitle>
          <CardDescription>
            Uninstalls every installed plugin and deletes their stored secrets. Bundled plugins are kept.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="destructive"
            onClick={() => setRemoveAllOpen(true)}
            disabled={!plugins || plugins.every((p) => p.bundled)}
          >
            Remove all plugins
          </Button>
        </CardContent>
      </Card>

      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Configure {editingPlugin?.name}</DialogTitle>
            <DialogDescription>Edit the plugin's configuration as JSON.</DialogDescription>
          </DialogHeader>
          {editor && (
            <div className="flex flex-col gap-1.5">
              <Textarea
                value={editor.text}
                onChange={(event) => setEditor({ ...editor, text: event.target.value, error: null })}
                className="min-h-48 font-mono text-xs"
                spellCheck={false}
              />
              {editor.error && <p className="text-xs text-destructive">{editor.error}</p>}
            </div>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button onClick={() => void handleSaveConfig()} disabled={editor?.saving}>
              {editor?.saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={configForm !== null}
        onOpenChange={(open) => {
          if (!open) setConfigForm(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Configure {configFormPlugin?.name}</DialogTitle>
            <DialogDescription>Changes are saved as soon as you press Save.</DialogDescription>
          </DialogHeader>
          {configForm && (
            <div className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto pr-1">
              {configForm.schema.map((field) => (
                <ConfigField
                  key={field.name}
                  field={field}
                  value={configForm.values[field.name]}
                  onChange={(value) => setConfigFormValue(field.name, value)}
                />
              ))}
            </div>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              onClick={() => void handleSaveConfigForm()}
              disabled={configForm?.saving || configFormMissing.length > 0}
            >
              {configForm?.saving
                ? 'Saving…'
                : configFormMissing.length > 0
                  ? `${configFormMissing.map((f) => f.label).join(', ')} required`
                  : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={secrets !== null}
        onOpenChange={(open) => {
          if (!open) setSecrets(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="size-4" />
              Secrets — {secretsPlugin?.name}
            </DialogTitle>
            <DialogDescription>
              Encrypted at rest and kept separate from the plugin's config. Viewing or changing values requires your
              password.
            </DialogDescription>
          </DialogHeader>

          {secrets && (
            <div className="flex flex-col gap-4">
              {secrets.keysError && (
                <Alert variant="destructive">
                  <AlertTitle>Couldn't load secret names</AlertTitle>
                  <AlertDescription>{secrets.keysError}</AlertDescription>
                </Alert>
              )}

              {!secrets.elevated ? (
                <div className="flex flex-col gap-3">
                  {secrets.keys === null ? (
                    <Skeleton className="h-8 w-full" />
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {secretsDeclared.map((field) => (
                        <li key={field.name} className="flex flex-col gap-0.5 text-sm">
                          <span className="font-medium text-foreground">
                            {field.label}
                            {field.required && <span className="text-destructive"> *</span>}
                          </span>
                          {field.description && (
                            <span className="text-xs text-muted-foreground">{field.description}</span>
                          )}
                          <span className="font-mono text-xs text-muted-foreground">
                            {field.name} — {secrets.keys?.includes(field.name) ? 'set ••••••••' : 'not set'}
                          </span>
                        </li>
                      ))}
                      {secretsUndeclaredKeys.map((key) => (
                        <li key={key} className="font-mono text-sm text-muted-foreground">
                          {key} = ••••••••
                        </li>
                      ))}
                      {secretsDeclared.length === 0 && secretsUndeclaredKeys.length === 0 && (
                        <p className="text-sm text-muted-foreground">No variables set yet.</p>
                      )}
                    </ul>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="secrets-password">Password</Label>
                    <Input
                      id="secrets-password"
                      type="password"
                      value={secrets.password}
                      onChange={(event) => setSecrets({ ...secrets, password: event.target.value, elevateError: null })}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void handleElevate();
                      }}
                    />
                    {secrets.elevateError && <p className="text-xs text-destructive">{secrets.elevateError}</p>}
                  </div>
                  <Button onClick={() => void handleElevate()} disabled={secrets.elevating || !secrets.password}>
                    {secrets.elevating ? 'Unlocking…' : 'Unlock'}
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {secretsDeclared.length === 0 && secretsUndeclaredKeys.length === 0 && (
                    <p className="text-sm text-muted-foreground">No variables set yet.</p>
                  )}

                  {secretsDeclared.map((field) => (
                    <div key={field.name} className="flex flex-col gap-1.5">
                      <Label className="font-mono text-xs">
                        {field.label}
                        {field.required && <span className="text-destructive"> *</span>}
                      </Label>
                      <Input
                        className="font-mono"
                        placeholder={field.placeholder}
                        value={secrets.values?.[field.name] ?? ''}
                        onChange={(event) =>
                          setSecrets({
                            ...secrets,
                            values: { ...(secrets.values ?? {}), [field.name]: event.target.value },
                          })
                        }
                      />
                      {/* Declared secrets can be emptied but the row itself cannot be removed — no delete button. */}
                      {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
                    </div>
                  ))}

                  {secretsDeclared.length > 0 && secretsUndeclaredKeys.length > 0 && <Separator />}

                  {secretsUndeclaredKeys.map((key) => (
                    <div key={key} className="flex items-end gap-2">
                      <div className="flex flex-1 flex-col gap-1.5">
                        <Label className="font-mono text-xs">{key}</Label>
                        <Input
                          className="font-mono"
                          value={secrets.values?.[key] ?? ''}
                          onChange={(event) =>
                            setSecrets({
                              ...secrets,
                              values: { ...(secrets.values ?? {}), [key]: event.target.value },
                            })
                          }
                        />
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${key}`}
                        onClick={() => void handleDeleteSecret(key)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))}

                  <Separator />

                  <div className="flex items-end gap-2">
                    <div className="flex flex-1 flex-col gap-1.5">
                      <Label htmlFor="secrets-new-key">Name</Label>
                      <Input
                        id="secrets-new-key"
                        className="font-mono"
                        value={secrets.newKey}
                        onChange={(event) => setSecrets({ ...secrets, newKey: event.target.value, formError: null })}
                        placeholder="API_KEY"
                      />
                    </div>
                    <div className="flex flex-1 flex-col gap-1.5">
                      <Label htmlFor="secrets-new-value">Value</Label>
                      <Input
                        id="secrets-new-value"
                        className="font-mono"
                        value={secrets.newValue}
                        onChange={(event) => setSecrets({ ...secrets, newValue: event.target.value })}
                      />
                    </div>
                    <Button variant="outline" size="icon" aria-label="Add variable" onClick={handleAddSecret}>
                      <Plus />
                    </Button>
                  </div>
                  {secrets.formError && <p className="text-xs text-destructive">{secrets.formError}</p>}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
            {secrets?.elevated && (
              <Button onClick={() => void handleSaveSecrets()} disabled={secrets.saving}>
                {secrets.saving ? 'Saving…' : 'Save'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={panelDialog !== null}
        onOpenChange={(open) => {
          if (!open) setPanelDialog(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{panelDialog?.title}</DialogTitle>
            {panelDialog?.description && <DialogDescription>{panelDialog.description}</DialogDescription>}
          </DialogHeader>

          {panelDialog?.loading && (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}

          {panelDialog?.error && (
            <Alert variant="destructive">
              <AlertTitle>Couldn't load panel</AlertTitle>
              <AlertDescription>{panelDialog.error}</AlertDescription>
            </Alert>
          )}

          {panelDialog?.view && !panelDialog.loading && (
            <div className="flex flex-col gap-3">
              {panelDialog.view.elements.map((el, idx) => renderPanelElement(el, idx, panelElementHandlers))}
            </div>
          )}

          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={panelDialog?.confirm != null}
        onOpenChange={(open) => {
          if (!open) setPanelDialog((current) => (current ? { ...current, confirm: null } : current));
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Are you sure?</DialogTitle>
            <DialogDescription>{panelDialog?.confirm?.text}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              variant={panelDialog?.confirm?.tone === 'destructive' ? 'destructive' : 'default'}
              disabled={panelBusy}
              onClick={() => {
                if (panelDialog?.confirm) void runPanelAction(panelDialog.confirm.actionId);
              }}
            >
              {panelBusy ? 'Working…' : 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={uninstallTarget !== null}
        onOpenChange={(open) => {
          if (!open) setUninstallTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Uninstall {uninstallTarget?.name}?</DialogTitle>
            <DialogDescription>
              This removes the plugin package and its stored secrets. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button variant="destructive" onClick={() => void handleUninstall()} disabled={uninstalling}>
              {uninstalling ? 'Uninstalling…' : 'Uninstall'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={removeAllOpen} onOpenChange={setRemoveAllOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove all plugins?</DialogTitle>
            <DialogDescription>
              This uninstalls every installed plugin and deletes their stored secrets. Bundled plugins stay
              installed. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button variant="destructive" onClick={() => void handleRemoveAll()} disabled={removingAll}>
              {removingAll ? 'Removing…' : 'Remove all'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
