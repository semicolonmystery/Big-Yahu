import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronsUpDown, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AppSettings, ChannelPermission, Controller, GuildMember } from '@shared/types';
import { DUPLICATE_DISTANCE_MAX, FACT_SEARCH_MAX_DISTANCE_MAX, LANGUAGES } from '@shared/constants';
import { api } from '@/lib/api';
import { AiTasksSection } from '@/components/settings/AiTasksSection';
import { FactTypesSection } from '@/components/settings/FactTypesSection';
import { FactCleanupSection } from '@/components/settings/FactCleanupSection';
import { BundlingSection } from '@/components/settings/BundlingSection';
import type { FactType } from '@shared/factTypes';
import { EmbeddingSection } from '@/components/settings/EmbeddingSection';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '@/components/ui/command';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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

/** One numeric setting, so the card that shows it only has to name it. */
interface NumberSettingSpec {
  label: string;
  help: string;
  min: number;
  max: number;
}

const NUMBER_SETTINGS = {
  checkIntervalMinutes: {
    label: 'Check interval (minutes)',
    help: 'How often the bot scans channels for new facts.',
    min: 1,
    max: 1440,
  },
  replyContextMessages: {
    label: 'Reply context messages',
    help: 'How many recent messages it reads when replying.',
    min: 1,
    max: 100,
  },
  textAttachmentMaxKb: {
    label: 'Maximum message.txt size (KiB)',
    help: 'Largest message.txt attachment the bot reads. 0 disables text attachments; up to 64 KiB per file and 64 KiB total per conversation context.',
    min: 0,
    max: 64,
  },
  factSearchTopK: {
    label: 'Fact search top K',
    help: 'How many remembered facts it retrieves.',
    min: 1,
    max: 50,
  },
  factSearchMaxDistance: {
    label: 'Fact search maximum distance',
    help: 'How far a fact may be from the question and still be recalled, in the same hundredths as the duplicate '
      + 'distance. Without a ceiling, a question with nothing behind it is answered out of the least-bad matches. '
      + '0 switches it off.',
    min: 0,
    max: FACT_SEARCH_MAX_DISTANCE_MAX,
  },
  duplicateDistance: {
    label: 'Duplicate fact distance',
    help: 'How close two facts must be before a new one replaces the old, in hundredths of a vector distance: lower '
      + 'keeps more apart, higher merges more, 0 never merges. Re-tune it after changing the embedding model. Each '
      + 'fact type carries its own; this is the seed for a new one and the fallback for a fact with no type.',
    min: 0,
    max: DUPLICATE_DISTANCE_MAX,
  },
  escalationLookbackHours: {
    label: 'Escalation lookback (hours)',
    help: 'How far back it digs when it needs more context.',
    min: 1,
    max: 720,
  },
  maxEscalationDepth: {
    label: 'Max escalation depth',
    help: 'How many times it may ask for more context.',
    min: 0,
    max: 3,
  },
  rateLimitPerHour: {
    label: 'Rate limit per hour',
    help: 'How many replies one person can get per hour. 0 disables replies.',
    min: 0,
    max: 1000,
  },
  replySplitDelayMs: {
    label: 'Delay between reply messages (ms)',
    help: 'A reply written as several lines is sent as several messages, the way somebody typing actually sends '
      + 'them. This is the pause between them; 0 sends them as fast as Discord allows.',
    min: 0,
    max: 5000,
  },
  retryAttempts: {
    label: 'Retry attempts',
    help: 'How many extra times to retry a model when it returns a temporary error like 503 (high demand).',
    min: 0,
    max: 5,
  },
  retryDelayMs: {
    label: 'Retry delay (ms)',
    help: 'How long to wait between retries.',
    min: 0,
    max: 60000,
  },
  maxImages: {
    label: 'Max images per call',
    help: 'Ceiling on how many pictures go into one model call, newest first. Applies to both the reply pipeline '
      + 'and the periodic fact-extraction pass.',
    min: 0,
    max: 16,
  },
  crossChannelMessages: {
    label: 'Messages read from another channel',
    help: 'How much history the bot pulls from a channel it was pointed at — either because the message tagging it '
      + 'mentioned that channel, or because it asked to read one. Only channels with “read for facts” left on can '
      + 'be read this way. 0 switches cross-channel reading off entirely.',
    min: 0,
    max: 100,
  },
} satisfies Partial<Record<keyof AppSettings, NumberSettingSpec>>;

type NumberSettingKey = keyof typeof NUMBER_SETTINGS;

interface DraftProps {
  draft: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}

function NumberSetting({ name, draft, onChange }: DraftProps & { name: NumberSettingKey }) {
  const spec = NUMBER_SETTINGS[name];
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={name}>{spec.label}</Label>
      <Input
        id={name}
        type="number"
        min={spec.min}
        max={spec.max}
        value={draft[name]}
        // An emptied box is 0 rather than NaN, which would save as null and
        // read back as the default.
        onChange={(event) => onChange({ [name]: event.target.value === '' ? 0 : Number(event.target.value) })}
        className="max-w-xs"
      />
      <p className="text-xs text-muted-foreground">{spec.help}</p>
    </div>
  );
}

/**
 * One of the sentences the bot sends when it cannot answer. Capped rather than
 * stretched to the card: a message is a line or two, and a box the width of the
 * screen invites an essay nobody wants in a channel.
 */
function MessageSetting({
  name,
  label,
  help,
  draft,
  onChange,
}: DraftProps & { name: 'rateLimitMessage' | 'overloadMessage' | 'noCreditsMessage' | 'busyMessage' | 'errorMessage'; label: string; help: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Textarea
        id={name}
        value={draft[name]}
        onChange={(event) => onChange({ [name]: event.target.value })}
        className="max-w-md"
      />
      <p className="text-xs text-muted-foreground">{help}</p>
    </div>
  );
}

/** A switch with its explanation under it, which several behaviour settings are. */
function SwitchSetting({
  name,
  label,
  help,
  checked,
  disabled,
  onChange,
}: {
  name: string;
  label: string;
  help: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <Switch id={name} checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
        <Label htmlFor={name}>{label}</Label>
      </div>
      <p className="text-xs text-muted-foreground">{help}</p>
    </div>
  );
}

/** Every card on this page: a title, a sentence of its own, and a column of controls. */
function SettingsCard({
  title,
  description,
  className,
  children,
}: {
  title: string;
  description: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-5">{children}</div>
      </CardContent>
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
                  <TableCell className="font-medium">{controller.name}</TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${controller.name}`}
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
              {removeTarget?.name ?? ''} will no longer be able to direct the bot.
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

/** The language it answers in absent a signal, picked from a searchable list of 47. */
function LanguageSetting({ draft, onChange }: DraftProps) {
  const [open, setOpen] = useState(false);
  const selected = LANGUAGES.find((language) => language.code === draft.replyLanguage);

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="replyLanguage">Reply language</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              id="replyLanguage"
              variant="outline"
              role="combobox"
              aria-expanded={open}
              className="w-full max-w-xs justify-between font-normal"
            />
          }
        >
          {selected ? formatLanguage(selected) : 'Select language…'}
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
                      onChange({ replyLanguage: language.code });
                      setOpen(false);
                    }}
                  >
                    <Check className={cn('mr-2', draft.replyLanguage === language.code ? 'opacity-100' : 'opacity-0')} />
                    {formatLanguage(language)}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <p className="text-xs text-muted-foreground">
        The default language for replies. If someone tags the bot in a different language, it replies in that
        language instead.
      </p>
    </div>
  );
}

/** Small cards side by side, so a screen of settings is not one column three scrolls long. */
const TAB_GRID = 'grid items-start gap-4 lg:grid-cols-2';

export default function SettingsPage() {
  // Loaded once by the types section and handed on, so the cleanup section can
  // offer them without asking for the same list a second time.
  const [factTypes, setFactTypes] = useState<FactType[]>([]);
  const [original, setOriginal] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState('behaviour');

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

  const change = (values: Partial<AppSettings>) =>
    setDraft((current) => (current ? { ...current, ...values } : current));

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
      {/* The one Save on the page, and it stays put: a patch covers every tab,
          so hiding the button under the tab a change was made in would mean
          hunting for it. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
        <Button onClick={() => void handleSave()} disabled={saving || !hasChanges}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load settings</AlertTitle>
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
        <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
          {/* The row of tabs is wider than a phone; it scrolls rather than
              pushing the page sideways. */}
          <div className="max-w-full overflow-x-auto">
            <TabsList>
              <TabsTrigger value="behaviour">Behaviour</TabsTrigger>
              <TabsTrigger value="memory">Memory</TabsTrigger>
              <TabsTrigger value="models">Models</TabsTrigger>
              <TabsTrigger value="places">Channels &amp; people</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="behaviour">
            <div className={TAB_GRID}>
              <SettingsCard
                title="Replying"
                description="How much of the conversation it reads, and how the answer comes back out."
              >
                <NumberSetting name="replyContextMessages" draft={draft} onChange={change} />
                <NumberSetting name="replySplitDelayMs" draft={draft} onChange={change} />
                <NumberSetting name="crossChannelMessages" draft={draft} onChange={change} />
              </SettingsCard>

              <SettingsCard
                title="Language and time"
                description="What it answers in, and what it believes the date to be."
              >
                <LanguageSetting draft={draft} onChange={change} />
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="timezone">Timezone</Label>
                  <Input
                    id="timezone"
                    value={draft.timezone}
                    onChange={(event) => change({ timezone: event.target.value })}
                    className="max-w-xs font-mono"
                  />
                  <p className="text-xs text-muted-foreground">
                    IANA name, e.g. Europe/Prague. The bot is told the current date and time in this zone, so it can
                    answer questions about what day it is.
                  </p>
                </div>
              </SettingsCard>

              <SettingsCard
                title="Rate limit"
                description="How often one person may be answered, and what they get once they are past it."
              >
                <NumberSetting name="rateLimitPerHour" draft={draft} onChange={change} />
                <MessageSetting
                  name="rateLimitMessage"
                  label="Rate limit message"
                  help="The message sent when someone hits the rate limit cap."
                  draft={draft}
                  onChange={change}
                />
              </SettingsCard>

              <SettingsCard
                title="Retries"
                description="What happens when a model answers with a temporary error rather than a reply."
              >
                <NumberSetting name="retryAttempts" draft={draft} onChange={change} />
                <NumberSetting name="retryDelayMs" draft={draft} onChange={change} />
              </SettingsCard>

              <SettingsCard
                title="Pictures"
                description="Vision is the expensive part of a model call, so it is bounded on purpose."
              >
                <SwitchSetting
                  name="visionEnabled"
                  label="Vision"
                  help={'Whether the bot can see pictures at all. Turning this off makes every call text-only, even '
                    + 'for messages with attachments.'}
                  checked={draft.visionEnabled}
                  onChange={(checked) => change({ visionEnabled: checked })}
                />
                <SwitchSetting
                  name="imageLimitDisabled"
                  label="No limit on images"
                  help={'Every picture in the window goes to the model. This is the setting that costs money — it '
                    + 'exists because a question about a picture the bot was not sent cannot be answered.'}
                  checked={draft.imageLimitDisabled}
                  disabled={!draft.visionEnabled}
                  onChange={(checked) => change({ imageLimitDisabled: checked })}
                />
                {/* Hidden rather than disabled when the cap is off: a number that
                    does nothing, greyed out, still reads as the number in force. */}
                {!draft.imageLimitDisabled && <NumberSetting name="maxImages" draft={draft} onChange={change} />}
              </SettingsCard>

              <SettingsCard
                title="When it cannot answer"
                description="Four different failures, four sentences; the log names which one was sent."
              >
                <MessageSetting
                  name="overloadMessage"
                  label="High demand message"
                  help="The message sent when every model on the list stays unavailable after every retry."
                  draft={draft}
                  onChange={change}
                />
                <MessageSetting
                  name="noCreditsMessage"
                  label="Out of credit message"
                  help={'Sent when OpenRouter refuses on billing. Every model shares the key, so nothing retries out '
                    + 'of this one and no model is blamed for it — it needs you, not another try.'}
                  draft={draft}
                  onChange={change}
                />
                <MessageSetting
                  name="busyMessage"
                  label="Out of budget message"
                  help={'Sent when the reply runs out of attempts or takes too long. The bot\u2019s own limit, not the '
                    + 'provider\u2019s.'}
                  draft={draft}
                  onChange={change}
                />
                <MessageSetting
                  name="errorMessage"
                  label="Something went wrong message"
                  help={'Sent when the reply threw, or the model produced no text. Seeing this means a bug, not load '
                    + '— the console names the cause against the message id.'}
                  draft={draft}
                  onChange={change}
                />
              </SettingsCard>
            </div>
          </TabsContent>

          <TabsContent value="memory">
            <div className={TAB_GRID}>
              <SettingsCard
                title="Recall"
                description="How much the bot digs out of its memory for a question, and how close two facts must be to count as the same one."
              >
                <NumberSetting name="factSearchTopK" draft={draft} onChange={change} />
                <NumberSetting name="factSearchMaxDistance" draft={draft} onChange={change} />
                <NumberSetting name="duplicateDistance" draft={draft} onChange={change} />
              </SettingsCard>

              <SettingsCard
                title="Reading for facts"
                description="The periodic pass that turns channel history into what the bot remembers."
              >
                <NumberSetting name="checkIntervalMinutes" draft={draft} onChange={change} />
                <NumberSetting name="textAttachmentMaxKb" draft={draft} onChange={change} />
              </SettingsCard>

              <SettingsCard
                title="Asking for more context"
                description="When what it has in front of it is not enough to answer, how much further it may look."
              >
                <NumberSetting name="escalationLookbackHours" draft={draft} onChange={change} />
                <NumberSetting name="maxEscalationDepth" draft={draft} onChange={change} />
              </SettingsCard>

              <BundlingSection draft={draft} settings={original} onChange={change} />
              <EmbeddingSection />
              <FactCleanupSection types={factTypes} />
              <div className="lg:col-span-2"><FactTypesSection onTypes={setFactTypes} /></div>
            </div>
          </TabsContent>

          {/* Wide by nature: a row of tabs of its own, and a six-column table. */}
          <TabsContent value="models">
            <AiTasksSection />
          </TabsContent>

          <TabsContent value="places">
            <div className={TAB_GRID}>
              <ChannelPermissionsSection />
              <ControllersSection />
            </div>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
