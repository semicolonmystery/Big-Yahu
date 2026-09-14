import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, ChevronsUpDown, GripVertical, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { REASONING_EFFORTS } from '@shared/aiTasks';
import type { AiTaskView, AiTasksOverview, CatalogEndpoint, CatalogModel, TaskModelView } from '@shared/types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

/** A Select item cannot carry an empty value, so "let OpenRouter choose" gets a stand-in. */
const ANY_HOST = '__any__';

/** Prices arrive per million tokens. Cache reads are fractions of a cent, so they keep a third place. */
function formatPrice(price: number | null): string {
  if (price === null) return '?';
  return `$${price >= 0.01 ? price.toFixed(2) : price.toFixed(3)}`;
}

function hostLabel(host: CatalogEndpoint): string {
  const cached = host.cacheReadPrice === null ? '' : ` / ${formatPrice(host.cacheReadPrice)} cached`;
  return `${host.providerName}: ${formatPrice(host.promptPrice)} in / ${formatPrice(host.completionPrice)} out${cached}`
    + (host.timeOfDayPricing ? ', varies by time of day' : '')
    + (host.healthy ? '' : ', degraded');
}

type Run = (action: () => Promise<AiTasksOverview>, success?: string) => Promise<void>;

/**
 * Which host a row is pinned to. Hosts load when the picker opens, since most
 * visits to the page never change one. A host that cannot do what the task
 * needs is shown but cannot be picked, so the operator sees why it is not an option.
 */
function UpstreamPicker({ task, entry, disabled, run }: { task: AiTaskView; entry: TaskModelView; disabled: boolean; run: Run }) {
  const [hosts, setHosts] = useState<CatalogEndpoint[] | null>(null);

  const load = () => {
    if (hosts) return;
    api
      .modelHosts(entry.model)
      .then(setHosts)
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : "Couldn't load the hosts"));
  };

  const current = entry.upstream || ANY_HOST;
  const items = [
    { value: ANY_HOST, label: 'Any host (OpenRouter chooses)' },
    ...(hosts ?? []).map((host) => ({ value: host.tag, label: hostLabel(host) })),
  ];
  if (entry.upstream && !items.some((item) => item.value === entry.upstream)) {
    items.push({ value: entry.upstream, label: entry.upstream });
  }

  return (
    <Select
      items={items}
      value={current}
      disabled={disabled}
      onOpenChange={(open) => {
        if (open) load();
      }}
      onValueChange={(value) => {
        if (typeof value !== 'string' || value === current) return;
        const upstream = value === ANY_HOST ? '' : value;
        void run(() => api.setTaskModelUpstream(task.id, entry.model, upstream), `${entry.model} pinned to ${upstream || 'any host'}`);
      }}
    >
      <SelectTrigger size="sm" className="max-w-72" aria-label={`Host for ${entry.model}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {items.map((item) => {
          const host = hosts?.find((candidate) => candidate.tag === item.value);
          const unsuitable = host ? (task.usesTools && !host.tools) || (task.structured && !host.jsonMode) : false;
          return (
            <SelectItem key={item.value} value={item.value} disabled={unsuitable}>
              {item.label}
              {unsuitable && ' (cannot do this task)'}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

/** Searches OpenRouter's catalog as you type, rather than loading all of it into the page. */
function ModelSearch({ disabled, onAdd }: { disabled: boolean; onAdd: (model: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CatalogModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .aiTaskCatalog(query.trim())
        .then((data) => {
          if (cancelled) return;
          setResults(data);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : 'Search failed');
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className="w-72 justify-between font-normal"
          />
        }
      >
        Add a model…
        <ChevronsUpDown className="opacity-50" />
      </PopoverTrigger>
      <PopoverContent className="w-[26rem] p-0">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search OpenRouter models…" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>{error ?? (results ? 'No model matches.' : 'Loading…')}</CommandEmpty>
            <CommandGroup>
              {(results ?? []).map((model) => (
                <CommandItem
                  key={model.id}
                  value={model.id}
                  onSelect={() => {
                    setOpen(false);
                    onAdd(model.id);
                  }}
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-mono text-xs">{model.id}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {formatPrice(model.promptPrice)} in / {formatPrice(model.completionPrice)} out
                      {model.images ? ', sees pictures' : ', text only'}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ModelStatus({ entry, now }: { entry: TaskModelView; now: number }) {
  // Retired is not a heavier shade of resting: nothing lifts it but Reset
  // errors, so it must not read as "back shortly".
  if (entry.retired) {
    return (
      <span className="text-xs">
        <Badge variant="destructive" className="mr-2">retired</Badge>
        OpenRouter says it does not exist. Reset errors to try it again
        {entry.lastError ? `: ${entry.lastError.slice(0, 60)}` : ''}
      </span>
    );
  }
  if ((entry.restingUntil ?? 0) > now) {
    return (
      <span className="text-xs">
        resting until {new Date(entry.restingUntil ?? 0).toLocaleTimeString()}
        {entry.lastError ? `: ${entry.lastError.slice(0, 60)}` : ''}
      </span>
    );
  }
  if (entry.consecutiveFailures > 0) return <span className="text-xs">{entry.consecutiveFailures} recent failure(s)</span>;
  return <span className="text-xs text-muted-foreground">ready</span>;
}

function TaskPanel({ task, busy, run }: { task: AiTaskView; busy: boolean; run: Run }) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<TaskModelView | null>(null);
  // Rest periods expire on their own, so the rows have to re-evaluate over time.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const models = task.models;
  const move = (from: number, to: number) => {
    if (from < 0 || to < 0 || to >= models.length || from === to) return;
    const order = models.map((entry) => entry.model);
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    void run(() => api.reorderTaskModels(task.id, order));
  };

  const drop = (target: string) => {
    if (!dragging || dragging === target) return;
    move(
      models.findIndex((entry) => entry.model === dragging),
      models.findIndex((entry) => entry.model === target),
    );
    setDragging(null);
  };

  const needsReset = models.filter((entry) => entry.retired || (entry.restingUntil ?? 0) > now);

  return (
    <div className="flex flex-col gap-5 pt-4">
      <p className="text-sm text-muted-foreground">{task.description}</p>

      {task.warnings.length > 0 && (
        <Alert>
          <AlertTitle>Needs attention</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {task.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {task.reasoningEditable && (
        <div className="flex flex-col gap-1.5">
          <Label>Reasoning</Label>
          <Select
            items={REASONING_EFFORTS.map((effort) => ({ value: effort, label: effort === 'none' ? 'none (fastest, cheapest)' : effort }))}
            value={task.reasoningEffort}
            disabled={busy}
            onValueChange={(value) => {
              if (typeof value !== 'string' || value === task.reasoningEffort) return;
              void run(() => api.setReasoningEffort(task.id, value), `Reasoning set to ${value}`);
            }}
          >
            <SelectTrigger className="w-60" aria-label="Reasoning effort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REASONING_EFFORTS.map((effort) => (
                <SelectItem key={effort} value={effort}>
                  {effort === 'none' ? 'none (fastest, cheapest)' : effort}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            How much the model thinks before answering. Thinking is slower and billed as output. Tasks that answer
            in JSON always run without it.
          </p>
        </div>
      )}

      {models.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing on this list yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10" />
              <TableHead>Model</TableHead>
              <TableHead>Host</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-28 text-right">Order</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {models.map((entry, index) => {
              const unavailable = entry.retired || (entry.restingUntil ?? 0) > now;
              return (
                <TableRow
                  key={entry.model}
                  draggable={!busy}
                  onDragStart={() => setDragging(entry.model)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => drop(entry.model)}
                  onDragEnd={() => setDragging(null)}
                  className={cn('cursor-grab', dragging === entry.model && 'opacity-50', unavailable && 'text-muted-foreground')}
                >
                  <TableCell className="text-muted-foreground">
                    <GripVertical className="size-4" />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono">{entry.model}</span>
                      {index === 0 && !unavailable && <Badge variant="secondary">first choice</Badge>}
                      {task.usesImages && entry.capabilities && (
                        <Badge variant="outline">{entry.capabilities.images ? 'sees pictures' : 'text only'}</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <UpstreamPicker task={task} entry={entry} disabled={busy} run={run} />
                  </TableCell>
                  <TableCell>
                    <ModelStatus entry={entry} now={now} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || index === 0}
                      onClick={() => move(index, index - 1)}
                      aria-label={`Move ${entry.model} up`}
                    >
                      <ArrowUp className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || index === models.length - 1}
                      onClick={() => move(index, index + 1)}
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

      <div className="flex flex-wrap items-center gap-3">
        <ModelSearch
          disabled={busy}
          onAdd={(model) => void run(() => api.addTaskModel(task.id, model), `${model} added to ${task.label}`)}
        />
        {needsReset.length > 0 && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run(() => api.reviveTask(task.id), `Every ${task.label} model is back in rotation`)}
          >
            Reset errors on {needsReset.length} model{needsReset.length === 1 ? '' : 's'}
          </Button>
        )}
      </div>

      <Dialog open={removeTarget !== null} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {removeTarget?.model}?</DialogTitle>
            <DialogDescription>
              It will no longer be tried for {task.label.toLowerCase()}. If it is the only model here, that task cannot
              run at all.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const target = removeTarget;
                if (!target) return;
                setRemoveTarget(null);
                void run(() => api.removeTaskModel(task.id, target.model), `${target.model} removed`);
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * One ordered OpenRouter model list per job the bot does. Each call walks its
 * list top to bottom, and every row is pinned to a host, because the same model
 * costs very different amounts depending on who serves it.
 */
export function AiTasksSection() {
  const [overview, setOverview] = useState<AiTasksOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('reply');

  useEffect(() => {
    let cancelled = false;
    api
      .aiTasks()
      .then((data) => {
        if (!cancelled) setOverview(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load the AI tasks');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const run: Run = async (action, success) => {
    setBusy(true);
    try {
      setOverview(await action());
      if (success) toast.success(success);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI models (OpenRouter)</CardTitle>
        <CardDescription>
          One list per job. Each call tries its list top to bottom, moving on when a model fails, and rests a model
          that keeps failing. Every row is pinned to a host: the same model costs very different amounts depending on
          who serves it, and DeepSeek&apos;s own host is the only one with its off-peak prices and cheap cached input.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t load the AI tasks</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {overview && !overview.openrouterConfigured && (
          <Alert>
            <AlertTitle>OPENROUTER_API_KEY is not set</AlertTitle>
            <AlertDescription>These lists are saved, but nothing can run on them until the key is in the environment.</AlertDescription>
          </Alert>
        )}
        {overview && !overview.catalogAvailable && (
          <Alert>
            <AlertTitle>OpenRouter&apos;s model list could not be reached</AlertTitle>
            <AlertDescription>
              What each model can do, and what its hosts charge, cannot be checked right now. Changes are still saved.
            </AlertDescription>
          </Alert>
        )}

        {!overview ? (
          !error && <Skeleton className="h-40 w-full" />
        ) : (
          <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
            <TabsList>
              {overview.tasks.map((task) => (
                <TabsTrigger key={task.id} value={task.id}>
                  {task.label}
                  {task.warnings.length > 0 && (
                    <Badge variant="outline" className="ml-1.5">{task.warnings.length}</Badge>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
            {overview.tasks.map((task) => (
              <TabsContent key={task.id} value={task.id}>
                <TaskPanel task={task} busy={busy} run={run} />
              </TabsContent>
            ))}
          </Tabs>
        )}

        {overview && overview.plugins.length > 0 && (
          <div className="flex flex-col gap-3 border-t pt-4">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-foreground">Plugins</span>
              <span className="text-xs text-muted-foreground">
                What a plugin sends to a model goes through the shared Plugins list. Give one lists of its own
                when you want it on different models; they start as a copy of the shared list, and appear above
                as their own tabs.
              </span>
            </div>
            {overview.plugins.map((plugin) => (
              <div key={plugin.pluginId} className="flex flex-wrap items-center gap-3">
                <Switch
                  id={`shared-models-${plugin.pluginId}`}
                  checked={plugin.useSharedModels}
                  disabled={busy}
                  onCheckedChange={(checked) => void run(
                    () => api.setPluginSharedModels(plugin.pluginId, checked),
                    checked
                      ? `${plugin.pluginName} is back on the shared list`
                      : `${plugin.pluginName} has lists of its own now`,
                  )}
                  aria-label={`${plugin.pluginName} uses the shared list`}
                />
                <Label htmlFor={`shared-models-${plugin.pluginId}`}>{plugin.pluginName} uses the shared list</Label>
                <span className="text-xs text-muted-foreground">
                  {plugin.tasks.map((task) => task.label).join(', ')}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
