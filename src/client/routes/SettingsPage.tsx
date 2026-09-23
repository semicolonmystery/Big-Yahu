import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronsUpDown, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AppSettings, ChannelPermission, Controller, GuildMember } from '@shared/types';
import { DUPLICATE_DISTANCE_MAX, FACT_SEARCH_MAX_DISTANCE_MAX, LANGUAGES } from '@shared/constants';
import { api } from '@/lib/api';
import { AiTasksSection } from '@/components/settings/AiTasksSection';
import { FactTypesSection } from '@/components/settings/FactTypesSection';
import { FactCleanupSection } from '@/components/settings/FactCleanupSection';
import type { FactType } from '@shared/factTypes';
import { EmbeddingSection } from '@/components/settings/EmbeddingSection';
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';

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
    key: 'textAttachmentMaxKb',
    label: 'Maximum message.txt size (KiB)',
    help: 'Largest message.txt attachment the bot reads. 0 disables text attachments; up to 64 KiB per file and 64 KiB total per conversation context.',
    type: 'number',
    min: 0,
    max: 64,
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
    key: 'factSearchMaxDistance',
    label: 'Fact search maximum distance',
    help: 'How far a fact may be from the question and still be recalled, in the same hundredths as the '
      + 'duplicate distance. It caps what the top-K search returns, so a question with nothing relevant '
      + 'behind it comes back empty instead of with the least-bad matches. 0 switches the ceiling off.',
    type: 'number',
    min: 0,
    max: FACT_SEARCH_MAX_DISTANCE_MAX,
  },
  {
    key: 'duplicateDistance',
    label: 'Duplicate fact distance',
    help: 'How close two facts must be before a new one replaces the old instead of being stored beside it. '
      + 'Hundredths of a vector distance, so 25 means 0.25: lower keeps more separate facts, higher merges more, '
      + 'and 0 never merges anything. What counts as close depends on the embedding model, so re-tune this after '
      + 'changing it. Each fact type carries its own; this is the seed for a new one and the fallback for a fact '
      + 'with no type.',
    type: 'number',
    min: 0,
    max: DUPLICATE_DISTANCE_MAX,
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
    key: 'replySplitDelayMs',
    label: 'Delay between reply messages (ms)',
    help: 'A reply written as several lines is sent as several messages, the way somebody typing actually sends '
      + 'them. This is the pause between them; 0 sends them as fast as Discord allows.',
    type: 'number',
    min: 0,
    max: 5000,
  },
  {
    key: 'retryAttempts',
    label: 'Retry attempts',
    help: 'How many extra times to retry a model when it returns a temporary error like 503 (high demand).',
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

/**
 * Who may direct the bot.
 *
 * Added by picking a person, not by typing a snowflake: an id is unreadable, so
 * typing one is a transcription exercise with no feedback until it silently does
 * nothing. It is still the id that is stored — names change, ids do not — but
 * the id is never shown. Whatever Discord calls somebody today is what the panel
 * says, resolved on every load.
 */
function ControllersSection() {
  const [controllers, setControllers] = useState<Controller[] | null>(null);
  const [people, setPeople] = useState<GuildMember[]>([]);
  const [botOnline, setBotOnline] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Controller | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [rows, roster] = await Promise.all([api.listControllers(), api.listPeople()]);
        if (cancelled) return;
        setControllers(rows);
        setPeople(roster.people);
        setBotOnline(roster.botOnline);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Could not load the controllers');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // The id is the key; this is the only thing that turns it back into a person.
  const nameOf = (userId: string) => people.find((person) => person.id === userId)?.name
    ?? 'somebody the bot cannot see right now';

  const add = async (person: GuildMember) => {
    setBusy(true);
    try {
      const added = await api.addController(person.id);
      setControllers((current) => [...(current ?? []).filter((row) => row.userId !== added.userId), added]);
      setPickerOpen(false);
      toast.success(`${person.name} can direct the bot`);
    } catch (addError) {
      toast.error(addError instanceof Error ? addError.message : 'Could not add that controller');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!removeTarget) return;
    setBusy(true);
    try {
      await api.removeController(removeTarget.userId);
      setControllers((current) => (current ?? []).filter((row) => row.userId !== removeTarget.userId));
      setRemoveTarget(null);
    } catch (removeError) {
      toast.error(removeError instanceof Error ? removeError.message : 'Could not remove that controller');
    } finally {
      setBusy(false);
    }
  };

  const available = (controllers ?? []).length === 0
    ? people
    : people.filter((person) => !controllers!.some((row) => row.userId === person.id));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Controllers</CardTitle>
        <CardDescription>
          People who may direct the bot: tell it to remember something and it saves the fact, tell it to forget
          one and it deletes it. Everyone else it argues with.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {!botOnline && (
          <Alert>
            <AlertDescription>
              The bot is not connected, so there is nobody to choose from and existing controllers cannot be named.
            </AlertDescription>
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
                <TableHead>Who</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {controllers.map((controller) => (
                <TableRow key={controller.userId}>
                  <TableCell className="font-medium">{nameOf(controller.userId)}</TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${nameOf(controller.userId)}`}
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

        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger
            render={<Button variant="outline" disabled={busy || available.length === 0}>Add a controller</Button>}
          />
          <PopoverContent className="w-72 p-0" align="start">
            <Command>
              <CommandInput placeholder="Search by name…" />
              <CommandList>
                <CommandEmpty>Nobody by that name is visible.</CommandEmpty>
                <CommandGroup>
                  {available.map((person) => (
                    <CommandItem
                      key={person.id}
                      value={`${person.name} ${person.username ?? ''}`}
                      onSelect={() => void add(person)}
                    >
                      {person.name}
                      {person.username && person.username !== person.name && (
                        <span className="ml-2 text-xs text-muted-foreground">{person.username}</span>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </CardContent>

      <Dialog open={removeTarget !== null} onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove this controller?</DialogTitle>
            <DialogDescription>
              {removeTarget ? nameOf(removeTarget.userId) : ''} will no longer be able to direct the bot.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button variant="destructive" onClick={() => void remove()} disabled={busy}>Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default function SettingsPage() {
  // Loaded once by the types section and handed on, so the cleanup section can
  // offer them without asking for the same list a second time.
  const [factTypes, setFactTypes] = useState<FactType[]>([]);
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
    // A grid rather than one long column: most of these cards are a few fields
    // wide and were being stretched across the whole screen, which put the ones
    // that matter three scrolls apart. `items-start` so a short card does not
    // grow to match a tall neighbour, and the wide ones — the model tabs, the
    // tables, the message textareas — say so themselves.
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2 2xl:grid-cols-3">
      <h1 className="col-span-full text-2xl font-semibold tracking-tight text-foreground">Settings</h1>

      {error && (
        <Alert variant="destructive" className="col-span-full">
          <AlertTitle>Couldn't load settings</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading || !draft ? (
        <div className="col-span-full flex flex-col gap-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        // Five message textareas and a language picker: readable at full width,
        // cramped in a third of one.
        <Card className="col-span-full">
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
                <div className="flex items-center gap-3">
                  <Switch
                    id="imageLimitDisabled"
                    checked={draft.imageLimitDisabled}
                    disabled={!draft.visionEnabled}
                    onCheckedChange={(checked) => setDraft({ ...draft, imageLimitDisabled: checked })}
                    aria-label="Toggle the image limit"
                  />
                  <Label htmlFor="imageLimitDisabled">No limit on images</Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  Every picture in the window goes to the model. Vision is the expensive part of a call, so this
                  is the setting that costs money — it exists because a question about a picture the bot was not
                  sent cannot be answered.
                </p>
              </div>

              {/* Hidden rather than disabled when the cap is off: a number that
                  does nothing, greyed out, still reads as the number in force. */}
              {!draft.imageLimitDisabled && (
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
              )}

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
                  The message sent when every model on the list stays unavailable after every retry.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="noCreditsMessage">Out of credit message</Label>
                <Textarea
                  id="noCreditsMessage"
                  value={draft.noCreditsMessage}
                  onChange={(event) => setDraft({ ...draft, noCreditsMessage: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Sent when OpenRouter refuses on billing. Every model shares the key, so nothing retries out
                  of this one and no model is blamed for it &mdash; it needs you, not another try.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="busyMessage">Out of budget message</Label>
                <Textarea
                  id="busyMessage"
                  value={draft.busyMessage}
                  onChange={(event) => setDraft({ ...draft, busyMessage: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Sent when the reply runs out of attempts or takes too long. The bot&apos;s own limit, not the provider&apos;s.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="errorMessage">Something went wrong message</Label>
                <Textarea
                  id="errorMessage"
                  value={draft.errorMessage}
                  onChange={(event) => setDraft({ ...draft, errorMessage: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Sent when the reply threw, or the model produced no text. Seeing this means a bug, not load —
                  the console names the cause against the message id.
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

      {/* Wide by nature: a row of tabs, and a table that scrolls sideways if it must. */}
      <div className="col-span-full"><AiTasksSection /></div>
      <div className="col-span-full lg:col-span-1"><EmbeddingSection /></div>
      <div className="col-span-full lg:col-span-1"><FactCleanupSection types={factTypes} /></div>
      <div className="col-span-full"><FactTypesSection onTypes={setFactTypes} /></div>
      <div className="col-span-full lg:col-span-1"><ChannelPermissionsSection /></div>
      <div className="col-span-full lg:col-span-1"><ControllersSection /></div>
    </div>
  );
}
