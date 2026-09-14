import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { FactType } from '@shared/factTypes';
import type { FactAuthor, FactWithSources } from '@shared/types';
import { USER_MENTION_SPLIT } from '@shared/discord';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Search, Trash2, Check, ChevronsUpDown } from 'lucide-react';

const BROWSE_PAGE_SIZE = 20;

/**
 * Facts store people as `<@id>`, never as a name, so a rename cannot strand
 * them. The panel resolves those ids for reading, and marks each one so it is
 * obvious the fact holds an id rather than the name being shown — otherwise the
 * two are indistinguishable here, and the storage looks like it never changed.
 * The raw id is on the title attribute.
 */
function FactText({ text, names }: { text: string; names: Record<string, string> }) {
  return (
    <>
      {text.split(USER_MENTION_SPLIT).map((piece, index) =>
        index % 2 === 1 ? (
          <span
            key={index}
            title={`user id ${piece}`}
            className="rounded bg-primary/10 px-1 font-medium text-primary"
          >
            @{names[piece] ?? piece}
          </span>
        ) : (
          piece
        ),
      )}
    </>
  );
}

/** Whole days since the epoch is how a fact's date range is stored. */
function dayLabel(day: number): string {
  return new Date(day * 86_400_000).toLocaleDateString(undefined, { day: 'numeric', month: 'numeric', year: 'numeric' });
}

/**
 * The things a fact carries that its sentence does not say: when it is about,
 * when it was written down, and who it records.
 *
 * The two dates are genuinely different and the panel used to show neither. The
 * span is the days the fact itself talks about, read out of its text; `stored`
 * is when the bot wrote it down, which is not evidence of when anything
 * happened — the distinction the extraction prompts now spell out, and the one
 * an operator needs when deciding whether a fact is wrong.
 */
function FactDetails({ fact }: { fact: FactWithSources }) {
  const { dateMin, dateMax, createdAt } = fact.metadata;
  const people = [...new Set([...(fact.metadata.authorIds ?? []), ...(fact.metadata.subjectIds ?? [])])];
  const named = people.map((id) => fact.peopleNames?.[id]).filter(Boolean);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {dateMin !== undefined && (
        <span>
          about {dayLabel(dateMin)}
          {dateMax !== undefined && dateMax !== dateMin ? ` – ${dayLabel(dateMax)}` : ''}
        </span>
      )}
      {createdAt > 0 && <span>stored {new Date(createdAt).toLocaleDateString()}</span>}
      {named.length > 0 && <span>about {named.join(', ')}</span>}
      {named.length === 0 && people.length > 0 && (
        <span>about {people.length} {people.length === 1 ? 'person' : 'people'} the bot cannot name right now</span>
      )}
    </div>
  );
}

function FactCard({ fact, onDeleted }: { fact: FactWithSources; onDeleted: (id: string) => void }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);


  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.deleteFact(fact.id);
      toast.success('Fact deleted');
      setConfirmOpen(false);
      onDeleted(fact.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete fact');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={fact.metadata.source === 'reply' ? 'secondary' : 'outline'}>
            {fact.metadata.source}
          </Badge>
          {/* What kind of thing it is. Nothing here means nobody has sorted it
              yet, which is why it still comes back from every type search. */}
          {(fact.metadata.types ?? []).map((type) => (
            <Badge key={type} variant="secondary">{type}</Badge>
          ))}
          {(fact.metadata.types ?? []).length === 0 && (
            <Badge variant="outline" className="text-muted-foreground">no type yet</Badge>
          )}
          {fact.distance !== null && (
            <span className="text-xs text-muted-foreground">distance {fact.distance.toFixed(2)}</span>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Delete fact"
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 />
          </Button>
        </div>
        <CardTitle className="text-base font-normal">
          <FactText text={fact.text} names={fact.mentionNames} />
        </CardTitle>
        <FactDetails fact={fact} />
      </CardHeader>
      {fact.sourceMessages.length > 0 && (
        <CardContent>
          <p className="mb-2 text-xs font-medium text-muted-foreground">Source messages</p>
          <ul className="flex flex-col gap-2">
            {fact.sourceMessages.map((source) => (
              <li key={source.messageId} className="text-sm">
                <span className="font-medium text-foreground">{source.authorUsername}</span>
                <span className="text-muted-foreground">: {source.content} </span>
                <a
                  href={source.jumpLink}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline underline-offset-2"
                >
                  jump to message
                </a>
              </li>
            ))}
          </ul>
        </CardContent>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this fact?</DialogTitle>
            <DialogDescription>
              “<FactText text={fact.text} names={fact.mentionNames} />” will be permanently deleted. This
              can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

type SearchState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'error'; message: string }
  | { status: 'done'; results: FactWithSources[] };

function SearchTab() {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>({ status: 'idle' });

  const runSearch = async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setState({ status: 'searching' });
    try {
      const results = await api.searchFacts(trimmed);
      setState({ status: 'done', results });
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : 'Search failed' });
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void runSearch();
  };

  const handleDeleted = (id: string) => {
    setState((prev) => (prev.status === 'done' ? { ...prev, results: prev.results.filter((f) => f.id !== id) } : prev));
  };

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={handleSubmit} className="flex gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search remembered facts…"
          aria-label="Search facts"
        />
        <Button type="submit" disabled={state.status === 'searching' || query.trim().length === 0}>
          <Search />
          Search
        </Button>
      </form>

      {state.status === 'idle' && (
        <p className="text-sm text-muted-foreground">Search for a fact to see what the bot remembers and where it came from.</p>
      )}

      {state.status === 'searching' && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {state.status === 'error' && (
        <Alert variant="destructive">
          <AlertTitle>Search failed</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      {state.status === 'done' && state.results.length === 0 && (
        <p className="text-sm text-muted-foreground">No facts matched your search.</p>
      )}

      {state.status === 'done' && state.results.length > 0 && (
        <div className="flex flex-col gap-4">
          {state.results.map((fact) => (
            <FactCard key={fact.id} fact={fact} onDeleted={handleDeleted} />
          ))}
        </div>
      )}
    </div>
  );
}

type BrowseState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; facts: FactWithSources[]; total: number; page: number; pageSize: number };

function BrowseTab() {
  const [browseState, setBrowseState] = useState<BrowseState>({ status: 'loading' });
  const [browsePage, setBrowsePage] = useState(1);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [selectedAuthorId, setSelectedAuthorId] = useState<string | null>(null);
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [factTypes, setFactTypes] = useState<FactType[]>([]);
  const [authors, setAuthors] = useState<FactAuthor[]>([]);
  const [authorPickerOpen, setAuthorPickerOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .factAuthors()
      .then((data) => {
        if (!cancelled) setAuthors(data);
      })
      .catch(() => {
        // The person filter is a convenience; leave it empty if it fails to load.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.listFactTypes()
      .then((overview) => { if (!cancelled) setFactTypes(overview.types); })
      .catch(() => {
        // Same: without the list there are simply no type chips to offer.
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .listFacts({
        page: browsePage,
        pageSize: BROWSE_PAGE_SIZE,
        authorId: selectedAuthorId ?? undefined,
        types: selectedTypes,
      })
      .then((data) => {
        if (cancelled) return;
        const lastPage = Math.max(1, Math.ceil(data.total / data.pageSize));
        if (browsePage > lastPage) {
          setBrowsePage(lastPage);
          return;
        }
        setBrowseState({ status: 'done', facts: data.facts, total: data.total, page: data.page, pageSize: data.pageSize });
      })
      .catch((err: unknown) => {
        if (!cancelled) setBrowseState({ status: 'error', message: err instanceof Error ? err.message : 'Failed to load facts' });
      });
    return () => {
      cancelled = true;
    };
  }, [browsePage, selectedAuthorId, selectedTypes, refreshVersion]);

  const handleDeleted = (id: string) => {
    setBrowseState((prev) =>
      prev.status === 'done' ? { ...prev, facts: prev.facts.filter((f) => f.id !== id), total: prev.total - 1 } : prev,
    );
    // Refill this page, or move back if its last fact was removed. The server's
    // total also handles facts removed concurrently by another admin or the bot.
    setRefreshVersion((version) => version + 1);
  };

  const selectFilter = (authorId: string | null) => {
    setSelectedAuthorId(authorId);
    setBrowsePage(1);
    setAuthorPickerOpen(false);
  };

  const toggleType = (id: string) => {
    setSelectedTypes((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
    setBrowsePage(1);
  };

  const selectedAuthor = authors.find((author) => author.authorId === selectedAuthorId) ?? null;
  const totalPages = browseState.status === 'done' ? Math.max(1, Math.ceil(browseState.total / browseState.pageSize)) : 1;

  return (
    <div className="flex flex-col gap-6">
      {factTypes.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Types</span>
          {factTypes.map((type) => (
            <Button
              key={type.id}
              size="sm"
              variant={selectedTypes.includes(type.id) ? 'secondary' : 'outline'}
              onClick={() => toggleType(type.id)}
            >
              {type.label}
            </Button>
          ))}
          {selectedTypes.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => { setSelectedTypes([]); setBrowsePage(1); }}>
              Clear
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            Facts nobody has sorted yet come back whichever types are chosen, the same way they do in recall.
          </span>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <Popover open={authorPickerOpen} onOpenChange={setAuthorPickerOpen}>
          <PopoverTrigger
            render={
              <Button
                variant="outline"
                role="combobox"
                aria-expanded={authorPickerOpen}
                className="w-full max-w-xs justify-between font-normal"
              />
            }
          >
            {selectedAuthor ? `${selectedAuthor.authorUsername} (${selectedAuthor.factCount})` : 'Everyone'}
            <ChevronsUpDown className="opacity-50" />
          </PopoverTrigger>
          <PopoverContent className="w-72 p-0">
            <Command>
              <CommandInput placeholder="Search person…" />
              <CommandList>
                <CommandEmpty>No one found.</CommandEmpty>
                <CommandGroup>
                  <CommandItem value="everyone" onSelect={() => selectFilter(null)}>
                    <Check className={cn('mr-2', selectedAuthorId === null ? 'opacity-100' : 'opacity-0')} />
                    Everyone
                  </CommandItem>
                  {authors.map((author) => (
                    <CommandItem
                      key={author.authorId}
                      value={author.authorUsername}
                      onSelect={() => selectFilter(author.authorId)}
                    >
                      <Check
                        className={cn('mr-2', selectedAuthorId === author.authorId ? 'opacity-100' : 'opacity-0')}
                      />
                      {author.authorUsername}
                      <span className="ml-auto text-xs text-muted-foreground">{author.factCount}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      {browseState.status === 'loading' && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {browseState.status === 'error' && (
        <Alert variant="destructive">
          <AlertTitle>Couldn't load facts</AlertTitle>
          <AlertDescription>{browseState.message}</AlertDescription>
        </Alert>
      )}

      {browseState.status === 'done' && browseState.total === 0 && selectedAuthorId === null && (
        <p className="text-sm text-muted-foreground">No facts have been learned yet.</p>
      )}

      {browseState.status === 'done' && browseState.total === 0 && selectedAuthorId !== null && (
        <p className="text-sm text-muted-foreground">No facts from this person.</p>
      )}

      {browseState.status === 'done' && browseState.total > 0 && (
        <>
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">{browseState.total} facts</p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setBrowsePage((page) => page - 1)}
                disabled={browsePage <= 1}
              >
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {browseState.page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setBrowsePage((page) => page + 1)}
                disabled={browsePage >= totalPages}
              >
                Next
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            {browseState.facts.map((fact) => (
              <FactCard key={fact.id} fact={fact} onDeleted={handleDeleted} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function FactsSearchPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Facts</h1>

      <Tabs defaultValue="search">
        <TabsList>
          <TabsTrigger value="search">Search</TabsTrigger>
          <TabsTrigger value="browse">Browse</TabsTrigger>
        </TabsList>
        <TabsContent value="search" className="pt-4">
          <SearchTab />
        </TabsContent>
        <TabsContent value="browse" className="pt-4">
          <BrowseTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
