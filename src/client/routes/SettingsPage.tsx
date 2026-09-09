import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Check, ChevronsUpDown, GripVertical, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AppSettings, ChannelPermission, ChatModel, Controller } from '@shared/types';
import { LANGUAGES } from '@shared/constants';
import { api } from '@/lib/api';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '@/components/ui/command';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';

const SNOWFLAKE_RE = /^\d{17,20}$/;

function formatLanguage(language: (typeof LANGUAGES)[number]): string {
  return language.name === language.native ? language.name : `${language.name} — ${language.native}`;
}

/** So typing "Cestina" finds "Čeština" — few people reach for diacritics when searching. */
function foldDiacritics(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

function searchValue(language: (typeof LANGUAGES)[number]): string {
  return `${language.name} ${language.native} ${foldDiacritics(language.native)}`;
}

interface FieldSpec {
  key: keyof AppSettings;
  label: string;
  help: string;
  type: 'number' | 'textarea';
  min?: number;
  max?: number;
}

const FIELDS: FieldSpec[] = [
  {
    key: 'checkIntervalMinutes',
    label: 'Check interval (minutes)',
    help: 'How often the bot scans channels for new facts.',
    type: 'number',
    min: 1,
    max: 1440,
  },
  {
    key: 'replyContextMessages',
    label: 'Reply context messages',
    help: 'How many recent messages it reads when replying.',
    type: 'number',
    min: 1,
    max: 100,
  },
  {
    key: 'factSearchTopK',
    label: 'Fact search top K',
    help: 'How many remembered facts it retrieves.',
    type: 'number',
    min: 1,
    max: 50,
  },
  {
    key: 'escalationLookbackHours',
    label: 'Escalation lookback (hours)',
    help: 'How far back it digs when it needs more context.',
    type: 'number',
    min: 1,
    max: 720,
  },
  {
    key: 'maxEscalationDepth',
    label: 'Max escalation depth',
    help: 'How many times it may ask for more context.',
    type: 'number',
    min: 0,
    max: 3,
  },
  {
    key: 'rateLimitPerHour',
    label: 'Rate limit per hour',
    help: 'How many replies one person can get per hour. 0 disables replies.',
    type: 'number',
    min: 0,
    max: 1000,
  },
  {
    key: 'retryAttempts',
    label: 'Retry attempts',
    help: 'How many extra times to retry Gemini when it returns a temporary error like 503 (high demand).',
    type: 'number',
    min: 0,
    max: 5,
  },
  {
    key: 'retryDelayMs',
    label: 'Retry delay (ms)',
    help: 'How long to wait between retries.',
    type: 'number',
    min: 0,
    max: 60000,
  },
];

function ChatModelsSection() {
  const [models, setModels] = useState<ChatModel[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newModel, setNewModel] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ChatModel | null>(null);
  // Rest periods expire on their own, so the row has to re-evaluate over time.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .listModels()
      .then((data) => {
        if (!cancelled) setModels(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load models');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const persistOrder = async (ordered: ChatModel[]) => {
    const previous = models;
    setModels(ordered);
    setBusy(true);
    try {
      setModels(await api.reorderModels(ordered.map((entry) => entry.model)));
    } catch (err) {
      setModels(previous);
      toast.error(err instanceof Error ? err.message : 'Failed to save the order');
    } finally {
      setBusy(false);
    }
  };

  const move = (model: string, delta: number) => {
    if (!models) return;
    const from = models.findIndex((entry) => entry.model === model);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= models.length) return;
    const ordered = [...models];
    const [moved] = ordered.splice(from, 1);
    ordered.splice(to, 0, moved);
    void persistOrder(ordered);
  };

  const handleDrop = (targetModel: string) => {
    if (!models || !dragging || dragging === targetModel) return;
    const from = models.findIndex((entry) => entry.model === dragging);
    const to = models.findIndex((entry) => entry.model === targetModel);
    if (from < 0 || to < 0) return;
    const ordered = [...models];
    const [moved] = ordered.splice(from, 1);
    ordered.splice(to, 0, moved);
    setDragging(null);
    void persistOrder(ordered);
  };

  const handleAdd = async (event: FormEvent) => {
    event.preventDefault();
    const model = newModel.trim();
    if (!model) return;
    setAdding(true);
    try {
      await api.addModel(model);
      setModels(await api.listModels());
      setNewModel('');
      toast.success(`${model} added`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add the model');
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async () => {
    if (!removeTarget) return;
    setBusy(true);
    try {
      setModels(await api.removeModel(removeTarget.model));
      toast.success(`${removeTarget.model} removed`);
      setRemoveTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove the model');
    } finally {
      setBusy(false);
    }
  };

  const handleRevive = async () => {
    setBusy(true);
    try {
      setModels(await api.reviveModels());
      toast.success('Every model is back in rotation');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to revive the models');
    } finally {
      setBusy(false);
    }
  };

  const resting = (models ?? []).filter((entry) => (entry.restingUntil ?? 0) > now);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Chat models</CardTitle>
        <CardDescription>
          Tried top to bottom. When one fails the next is used instead of retrying the same one; a model that keeps
          failing is rested for a while. Drag to reorder, or use the arrows.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-5">
          {error && (
            <Alert variant="destructive">
              <AlertTitle>Couldn't load models</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {loading ? (
            <Skeleton className="h-28 w-full" />
          ) : !models || models.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No models configured. Without at least one the bot cannot reply at all.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10" />
                  <TableHead>Model</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-28 text-right">Order</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {models.map((entry, index) => {
                  const isResting = (entry.restingUntil ?? 0) > now;
                  return (
                    <TableRow
                      key={entry.model}
                      draggable={!busy}
                      onDragStart={() => setDragging(entry.model)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={() => handleDrop(entry.model)}
                      onDragEnd={() => setDragging(null)}
                      className={cn(
                        'cursor-grab',
                        dragging === entry.model && 'opacity-50',
                        isResting && 'text-muted-foreground',
                      )}
                    >
                      <TableCell className="text-muted-foreground">
                        <GripVertical className="size-4" />
                      </TableCell>
                      <TableCell className="font-mono">
                        {entry.model}
                        {index === 0 && !isResting && (
                          <Badge variant="secondary" className="ml-2">
                            first choice
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {isResting ? (
                          <span className="text-xs">
                            resting until {new Date(entry.restingUntil ?? 0).toLocaleTimeString()}
                            {entry.lastError ? ` — ${entry.lastError.slice(0, 60)}` : ''}
                          </span>
                        ) : entry.consecutiveFailures > 0 ? (
                          <span className="text-xs">{entry.consecutiveFailures} recent failure(s)</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">ready</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy || index === 0}
                          onClick={() => move(entry.model, -1)}
                          aria-label={`Move ${entry.model} up`}
                        >
                          <ArrowUp className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy || index === models.length - 1}
                          onClick={() => move(entry.model, 1)}
                          aria-label={`Move ${entry.model} down`}
                        >
                          <ArrowDown className="size-4" />
                        </Button>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setRemoveTarget(entry)}
                          aria-label={`Remove ${entry.model}`}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}

          <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => void handleAdd(event)}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="newModel">Add a model</Label>
              <Input
                id="newModel"
                value={newModel}
                onChange={(event) => setNewModel(event.target.value)}
                placeholder="gemini-3.1-flash-lite"
                className="w-72 font-mono"
              />
            </div>
            <Button type="submit" disabled={adding || !newModel.trim()}>
              {adding ? 'Adding…' : 'Add'}
            </Button>
            {resting.length > 0 && (
              <Button type="button" variant="outline" disabled={busy} onClick={() => void handleRevive()}>
                Wake {resting.length} resting model{resting.length === 1 ? '' : 's'}
              </Button>
            )}
          </form>
        </div>
      </CardContent>

      <Dialog open={removeTarget !== null} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {removeTarget?.model}?</DialogTitle>
            <DialogDescription>
              It will no longer be tried. If it is the only model, the bot cannot reply at all.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button variant="destructive" disabled={busy} onClick={() => void handleRemove()}>
              {busy ? 'Removing…' : 'Remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function ChannelPermissionsSection() {
  const [channels, setChannels] = useState<ChannelPermission[] | null>(null);
  const [botOnline, setBotOnline] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    api
      .listChannels()
      .then((data) => {
        if (cancelled) return;
        setChannels(data.channels);
        setBotOnline(data.botOnline);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load channels');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggle = async (channelId: string, field: 'canReply' | 'canExtract', value: boolean) => {
    const previous = channels;
    setChannels((current) =>
      (current ?? []).map((channel) => (channel.channelId === channelId ? { ...channel, [field]: value } : channel)),
    );
    setPendingIds((current) => new Set(current).add(channelId));
    try {
      const patchValues = field === 'canReply' ? { canReply: value } : { canExtract: value };
      const updated = await api.updateChannel(channelId, patchValues);
      setChannels((current) =>
        (current ?? []).map((channel) => (channel.channelId === channelId ? updated : channel)),
      );
    } catch (err) {
      setChannels(previous);
      toast.error(err instanceof Error ? err.message : 'Failed to update channel');
    } finally {
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(channelId);
        return next;
      });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Channel permissions</CardTitle>
        <CardDescription>
          Reply lets the bot answer in a channel at all — off means it stays silent there even when tagged directly.
          It is on unless you turn it off.
          Read for facts lets the bot mine that channel's history into its permanent memory, and lets it be
          pointed at the channel from elsewhere. It is off unless you turn it on: what the bot learns here can
          be recalled, quoted and linked in any channel it replies in, so nothing is read until you say so.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-5">
          {error && (
            <Alert variant="destructive">
              <AlertTitle>Couldn't load channels</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {!loading && !error && !botOnline && (
            <Alert>
              <AlertTitle>Bot not connected</AlertTitle>
              <AlertDescription>
                The bot isn't connected to Discord right now, so this list may be incomplete — only previously
                configured channels can be shown.
              </AlertDescription>
            </Alert>
          )}

          {loading ? (
            <Skeleton className="h-24 w-full" />
          ) : !channels || channels.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No channels yet. The bot must be connected and in a server for its channels to be listed.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Channel</TableHead>
                  <TableHead>Reply</TableHead>
                  <TableHead>Read for facts</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {channels.map((channel) => {
                  const stale = channel.name?.endsWith('(not visible)') ?? false;
                  const pending = pendingIds.has(channel.channelId);
                  return (
                    <TableRow key={channel.channelId}>
                      <TableCell className={cn('font-medium', stale && 'font-normal italic text-muted-foreground')}>
                        {channel.name}
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={channel.canReply}
                          disabled={pending}
                          onCheckedChange={(checked) => void handleToggle(channel.channelId, 'canReply', checked)}
                          aria-label={`Toggle reply for ${channel.name}`}
                        />
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={channel.canExtract}
                          disabled={pending}
                          onCheckedChange={(checked) => void handleToggle(channel.channelId, 'canExtract', checked)}
                          aria-label={`Toggle read for facts for ${channel.name}`}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ControllersSection() {
  const [controllers, setControllers] = useState<Controller[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState('');
  const [label, setLabel] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Controller | null>(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listControllers()
      .then((data) => {
        if (!cancelled) setControllers(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load controllers');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAdd = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedId = userId.trim();
    const trimmedLabel = label.trim();
    if (!SNOWFLAKE_RE.test(trimmedId)) {
      setValidationError('Discord user ID must be 17-20 digits.');
      return;
    }
    if (!trimmedLabel) {
      setValidationError('Label is required.');
      return;
    }
    setValidationError(null);
    setAdding(true);
    try {
      const created = await api.addController(trimmedId, trimmedLabel);
      setControllers((current) => [...(current ?? []), created]);
      setUserId('');
      setLabel('');
      toast.success('Controller added');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add controller');
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async () => {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await api.removeController(removeTarget.userId);
      setControllers((current) => (current ?? []).filter((controller) => controller.userId !== removeTarget.userId));
      toast.success('Controller removed');
      setRemoveTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove controller');
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Controllers</CardTitle>
        <CardDescription>
          Controllers are Discord users allowed to command the bot — they can tell it to remember or forget facts, and
          it complies.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-5">
          {error && (
            <Alert variant="destructive">
              <AlertTitle>Couldn't load controllers</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {loading ? (
            <Skeleton className="h-24 w-full" />
          ) : !controllers || controllers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No controllers yet. Without any, nobody can direct the bot.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>User ID</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {controllers.map((controller) => (
                  <TableRow key={controller.userId}>
                    <TableCell className="font-medium">{controller.label}</TableCell>
                    <TableCell className="font-mono text-muted-foreground">{controller.userId}</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${controller.label}`}
                        onClick={() => setRemoveTarget(controller)}
                      >
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <form onSubmit={(event) => void handleAdd(event)} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="controller-user-id">Discord user ID</Label>
              <Input
                id="controller-user-id"
                value={userId}
                onChange={(event) => {
                  setUserId(event.target.value);
                  setValidationError(null);
                }}
                placeholder="123456789012345678"
                className="font-mono"
              />
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="controller-label">Label</Label>
              <Input
                id="controller-label"
                value={label}
                onChange={(event) => {
                  setLabel(event.target.value);
                  setValidationError(null);
                }}
                placeholder="e.g. Moderator name"
              />
            </div>
            <Button type="submit" disabled={adding}>
              {adding ? 'Adding…' : 'Add'}
            </Button>
          </form>
          {validationError && <p className="text-xs text-destructive">{validationError}</p>}
        </div>
      </CardContent>

      <Dialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove this controller?</DialogTitle>
            <DialogDescription>
              {removeTarget?.label} ({removeTarget?.userId}) will no longer be able to direct the bot.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button variant="destructive" onClick={() => void handleRemove()} disabled={removing}>
              {removing ? 'Removing…' : 'Remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default function SettingsPage() {
  const [original, setOriginal] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((data) => {
        if (cancelled) return;
        setOriginal(data);
        setDraft(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load settings');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = useMemo(() => {
    if (!original || !draft) return {};
    const changed: Partial<AppSettings> = {};
    for (const key of Object.keys(original) as (keyof AppSettings)[]) {
      if (draft[key] !== original[key]) {
        (changed as Record<string, unknown>)[key] = draft[key];
      }
    }
    return changed;
  }, [original, draft]);

  const hasChanges = Object.keys(patch).length > 0;

  const handleNumberChange = (key: keyof AppSettings, value: string) => {
    if (!draft) return;
    const parsed = value === '' ? 0 : Number(value);
    setDraft({ ...draft, [key]: parsed });
  };

  const handleSave = async () => {
    if (!draft || !hasChanges) return;
    setSaving(true);
    try {
      const updated = await api.updateSettings(patch);
      setOriginal(updated);
      setDraft(updated);
      toast.success('Settings saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Couldn't load settings</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading || !draft ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Bot behavior</CardTitle>
            <CardDescription>Changes only apply once saved.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-5">

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="timezone">Timezone</Label>
                <Input
                  id="timezone"
                  value={draft.timezone}
                  onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}
                  className="max-w-xs font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  IANA name, e.g. Europe/Prague. The bot is told the current date and time in this zone, so it can
                  answer questions about what day it is.
                </p>
              </div>

              {FIELDS.map((field) => (
                <div key={field.key} className="flex flex-col gap-1.5">
                  <Label htmlFor={field.key}>{field.label}</Label>
                  <Input
                    id={field.key}
                    type="number"
                    min={field.min}
                    max={field.max}
                    value={draft[field.key] as number}
                    onChange={(event) => handleNumberChange(field.key, event.target.value)}
                    className="max-w-xs"
                  />
                  <p className="text-xs text-muted-foreground">{field.help}</p>
                </div>
              ))}

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-3">
                  <Switch
                    id="visionEnabled"
                    checked={draft.visionEnabled}
                    onCheckedChange={(checked) => setDraft({ ...draft, visionEnabled: checked })}
                    aria-label="Toggle vision"
                  />
                  <Label htmlFor="visionEnabled">Vision</Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  Whether the bot can see pictures at all. Vision is the expensive part of a model call, so turning
                  this off makes every call text-only, even for messages with attachments.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="maxImages">Max images per call</Label>
                <Input
                  id="maxImages"
                  type="number"
                  min={0}
                  max={16}
                  value={draft.maxImages}
                  onChange={(event) => handleNumberChange('maxImages', event.target.value)}
                  className="max-w-xs"
                />
                <p className="text-xs text-muted-foreground">
                  Ceiling on how many pictures go into one model call, newest first. Applies to both the reply
                  pipeline and the periodic fact-extraction pass.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="crossChannelMessages">Messages read from another channel</Label>
                <Input
                  id="crossChannelMessages"
                  type="number"
                  min={0}
                  max={100}
                  value={draft.crossChannelMessages}
                  onChange={(event) => handleNumberChange('crossChannelMessages', event.target.value)}
                  className="max-w-xs"
                />
                <p className="text-xs text-muted-foreground">
                  How much history the bot pulls from a channel it was pointed at — either because the message
                  tagging it mentioned that channel, or because it asked to read one. Only channels with
                  &ldquo;read for facts&rdquo; left on can be read this way. Set it to 0 to switch cross-channel
                  reading off entirely.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="replyLanguage">Reply language</Label>
                <Popover open={languagePickerOpen} onOpenChange={setLanguagePickerOpen}>
                  <PopoverTrigger
                    render={
                      <Button
                        id="replyLanguage"
                        variant="outline"
                        role="combobox"
                        aria-expanded={languagePickerOpen}
                        className="w-full max-w-xs justify-between font-normal"
                      />
                    }
                  >
                    {(() => {
                      const selected = LANGUAGES.find((language) => language.code === draft.replyLanguage);
                      return selected ? formatLanguage(selected) : 'Select language…';
                    })()}
                    <ChevronsUpDown className="opacity-50" />
                  </PopoverTrigger>
                  <PopoverContent className="w-72 p-0">
                    <Command>
                      <CommandInput placeholder="Search language…" />
                      <CommandList>
                        <CommandEmpty>No language found.</CommandEmpty>
                        <CommandGroup>
                          {LANGUAGES.map((language) => (
                            <CommandItem
                              key={language.code}
                              value={searchValue(language)}
                              onSelect={() => {
                                setDraft({ ...draft, replyLanguage: language.code });
                                setLanguagePickerOpen(false);
                              }}
                            >
                              <Check
                                className={cn(
                                  'mr-2',
                                  draft.replyLanguage === language.code ? 'opacity-100' : 'opacity-0',
                                )}
                              />
                              {formatLanguage(language)}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                <p className="text-xs text-muted-foreground">
                  The default language for replies. If someone tags the bot in a different language, it replies in
                  that language instead.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rateLimitMessage">Rate limit message</Label>
                <Textarea
                  id="rateLimitMessage"
                  value={draft.rateLimitMessage}
                  onChange={(event) => setDraft({ ...draft, rateLimitMessage: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">The message sent when someone hits the rate limit cap.</p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="overloadMessage">High demand message</Label>
                <Textarea
                  id="overloadMessage"
                  value={draft.overloadMessage}
                  onChange={(event) => setDraft({ ...draft, overloadMessage: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  The message sent when Gemini stays unavailable after every retry.
                </p>
              </div>
            </div>
          </CardContent>
          <CardFooter>
            <Button onClick={() => void handleSave()} disabled={saving || !hasChanges}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </CardFooter>
        </Card>
      )}

      <ChatModelsSection />
      <ChannelPermissionsSection />
      <ControllersSection />
    </div>
  );
}
