import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import type { FactType } from '@shared/factTypes';

/**
 * The kinds of thing the bot sorts facts into.
 *
 * The description is the working part, not a note to the operator: it is what
 * the model reads to decide which types a fact is and which to search. The three
 * numbers are per type because what counts as a duplicate of a one-line message
 * record is not what counts as a duplicate of a rule.
 */
const NUMBERS: Array<{ key: 'duplicateDistance' | 'factSearchTopK' | 'factSearchMaxDistance'; label: string; help: string; min: number; max: number }> = [
  {
    key: 'duplicateDistance',
    label: 'Duplicate distance',
    help: 'How close two facts of this type have to be to count as the same one. 0 never merges them.',
    min: 0,
    max: 60,
  },
  { key: 'factSearchTopK', label: 'Results per search', help: 'How many facts a search for this type may return.', min: 1, max: 50 },
  {
    key: 'factSearchMaxDistance',
    label: 'Search ceiling',
    help: 'How far a fact may be from the question and still come back. 0 switches the ceiling off.',
    min: 0,
    max: 200,
  },
];

function TypeEditor({ type, onSaved }: { type: FactType; onSaved: (saved: FactType) => void }) {
  // Seeded once and owned from here on: the row that comes back from a save is
  // what the draft becomes, so there is nothing to synchronise afterwards.
  const [draft, setDraft] = useState(type);
  const [saved, setSaved] = useState(type);
  const [saving, setSaving] = useState(false);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const save = async () => {
    setSaving(true);
    try {
      const result = await api.updateFactType(type.id, {
        label: draft.label,
        description: draft.description,
        duplicateDistance: draft.duplicateDistance,
        factSearchTopK: draft.factSearchTopK,
        factSearchMaxDistance: draft.factSearchMaxDistance,
      });
      setDraft(result);
      setSaved(result);
      onSaved(result);
      toast.success(`${result.label} saved`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save that type');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <code className="text-sm font-medium">{type.id}</code>
        {type.builtIn && <Badge variant="secondary">shipped</Badge>}
        <Input
          className="ml-auto w-48"
          aria-label={`Label for ${type.id}`}
          value={draft.label}
          onChange={(event) => setDraft({ ...draft, label: event.target.value })}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`description-${type.id}`}>What the model is told this type is for</Label>
        <Textarea
          id={`description-${type.id}`}
          rows={4}
          value={draft.description}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {NUMBERS.map((field) => (
          <div key={field.key} className="flex flex-col gap-1.5">
            <Label htmlFor={`${field.key}-${type.id}`}>{field.label}</Label>
            <Input
              id={`${field.key}-${type.id}`}
              type="number"
              min={field.min}
              max={field.max}
              value={draft[field.key]}
              onChange={(event) => setDraft({ ...draft, [field.key]: Number(event.target.value) })}
            />
            <p className="text-xs text-muted-foreground">{field.help}</p>
          </div>
        ))}
      </div>

      <div className="flex justify-end">
        <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>Save</Button>
      </div>
    </div>
  );
}

function AddType({ onAdded }: { onAdded: (added: FactType) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ id: '', label: '', description: '' });
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    try {
      onAdded(await api.addFactType(draft));
      toast.success(`${draft.label} added`);
      setDraft({ id: '', label: '', description: '' });
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add that type');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm">Add a type</Button>} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>A new kind of fact</DialogTitle>
          <DialogDescription>
            The description is read by the model, not by you: it decides what belongs here and what this type is
            searched for. The three numbers start from the global fact settings and can be tuned afterwards.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-type-id">Id</Label>
            <Input
              id="new-type-id"
              placeholder="project"
              className="font-mono"
              value={draft.id}
              onChange={(event) => setDraft({ ...draft, id: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-type-label">Label</Label>
            <Input
              id="new-type-label"
              placeholder="Project"
              value={draft.label}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-type-description">Description</Label>
            <Textarea
              id="new-type-description"
              rows={4}
              placeholder="An ongoing thing the server is doing — a team, a server, a mod. Search this when…"
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </div>
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button disabled={busy || !draft.id || !draft.label || !draft.description} onClick={() => void add()}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FactTypesSection({ onTypes }: { onTypes?: (types: FactType[]) => void } = {}) {
  // Depended on rather than closed over: the parent passes a stable setter, and
  // listing it is what keeps the rule honest instead of silenced.
  const [types, setTypes] = useState<FactType[] | null>(null);
  const [untyped, setUntyped] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const overview = await api.listFactTypes();
        if (cancelled) return;
        setTypes(overview.types);
        setUntyped(overview.untypedFacts);
        onTypes?.(overview.types);
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : 'Could not load the fact types');
      }
    })();
    return () => { cancelled = true; };
  }, [onTypes]);

  const replace = (saved: FactType) =>
    setTypes((current) => (current ?? []).map((type) => (type.id === saved.id ? saved : type)));

  const remove = async (type: FactType) => {
    try {
      await api.removeFactType(type.id);
      setTypes((current) => (current ?? []).filter((entry) => entry.id !== type.id));
      toast.success(`${type.label} removed`);
    } catch (removeError) {
      toast.error(removeError instanceof Error ? removeError.message : 'Could not remove that type');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Fact types</CardTitle>
        <CardDescription>
          What the bot sorts facts into. A fact carries several at once — nearly anything that says something is
          also a message — and a search can aim at one type rather than at the whole store.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {untyped > 0 && (
          <Alert>
            <AlertDescription>
              {untyped} fact{untyped === 1 ? '' : 's'} predate{untyped === 1 ? 's' : ''} types and have none.
              They come back from every type search rather than disappearing, until the cleanup pass sorts them.
            </AlertDescription>
          </Alert>
        )}

        {types === null
          ? <Skeleton className="h-40 w-full" />
          : types.map((type) => (
            <div key={type.id} className="flex flex-col gap-2">
              <TypeEditor type={type} onSaved={replace} />
              {!type.builtIn && (
                <div className="flex justify-end">
                  <Button variant="ghost" size="sm" onClick={() => void remove(type)}>
                    Remove {type.label}
                  </Button>
                </div>
              )}
            </div>
          ))}

        <div className="flex flex-wrap gap-2">
          <AddType onAdded={(added) => setTypes((current) => [...(current ?? []), added])} />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void api.resetFactTypes().then(setTypes).then(() => toast.success('Shipped types restored'))}
          >
            Put the shipped types back
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
