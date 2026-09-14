import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { AppSettings, EmbeddingStatus } from '@shared/types';
import { api } from '@/lib/api';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';

/** While a move is running, so the count is seen to climb rather than guessed at. */
const POLL_MS = 3000;

export function EmbeddingSection() {
  const [status, setStatus] = useState<EmbeddingStatus | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<{ embeddingModel: string; embeddingDimensions: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const [next, current] = await Promise.all([api.embeddingStatus(), api.getSettings()]);
    setStatus(next);
    setSettings(current);
    setDraft((existing) => existing ?? {
      embeddingModel: current.embeddingModel,
      embeddingDimensions: current.embeddingDimensions,
    });
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await load();
        if (cancelled) return;
        setError(null);
        // Only while something is actually moving; an idle panel should not poll.
        if (next.job?.status === 'running') timer.current = setTimeout(() => void tick(), POLL_MS);
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : 'Failed to read the embedding status');
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  const changed = Boolean(
    settings && draft
    && (draft.embeddingModel.trim() !== settings.embeddingModel || draft.embeddingDimensions !== settings.embeddingDimensions),
  );

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      setSettings(await api.updateSettings({
        embeddingModel: draft.embeddingModel.trim(),
        embeddingDimensions: draft.embeddingDimensions,
      }));
      setStatus(await api.embeddingStatus());
      toast.success('Saved. Re-embed to move the facts across.');
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  const reembed = async () => {
    setBusy(true);
    try {
      const next = await api.startReembed();
      setStatus(next);
      if (next.job?.status === 'running') timer.current = setTimeout(() => void load(), POLL_MS);
      toast.success('Moving the facts across.');
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : 'Failed to start');
    } finally {
      setBusy(false);
    }
  };

  const job = status?.job;
  const running = job?.status === 'running';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Embeddings</CardTitle>
        <CardDescription>
          What facts are turned into vectors with. A collection holds one model at one width, so changing either
          means moving every fact across &mdash; until that finishes, the old facts cannot be searched.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t read the embedding status</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : !status || !draft ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            {status.upToDate ? null : (
              <Alert>
                <AlertTitle>
                  {status.source.facts > 0
                    ? `${status.source.facts} fact${status.source.facts === 1 ? '' : 's'} are still embedded with ${status.source.model}`
                    : 'The fact store is not on the configured model yet'}
                </AlertTitle>
                <AlertDescription>
                  {status.source.facts > 0
                    ? 'They cannot be searched until they are moved. Nothing is deleted until every one of them is across.'
                    : 'There is nothing to move.'}
                </AlertDescription>
              </Alert>
            )}

            {job && job.status !== 'complete' ? (
              <div className="flex flex-col gap-2">
                <Progress value={job.total > 0 ? (job.copied / job.total) * 100 : 0} />
                <p className="text-xs text-muted-foreground">
                  {job.copied} of {job.total} moved to {job.targetModel}
                  {job.pausesRecall && running ? ' — the bot remembers nothing until this finishes' : ''}
                </p>
                {job.status === 'failed' ? (
                  <Alert variant="destructive">
                    <AlertTitle>The move stopped</AlertTitle>
                    <AlertDescription>
                      {job.lastError ?? 'Unknown error'} &mdash; nothing was lost. Re-embed picks up where it stopped.
                    </AlertDescription>
                  </Alert>
                ) : null}
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="embeddingModel">Embedding model</Label>
                <Input
                  id="embeddingModel"
                  value={draft.embeddingModel}
                  onChange={(event) => setDraft({ ...draft, embeddingModel: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">An OpenRouter embedding model id.</p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="embeddingDimensions">Dimensions</Label>
                <Input
                  id="embeddingDimensions"
                  type="number"
                  min={128}
                  max={3072}
                  value={draft.embeddingDimensions}
                  onChange={(event) => setDraft({ ...draft, embeddingDimensions: Number(event.target.value) })}
                />
                <p className="text-xs text-muted-foreground">
                  Narrower is cheaper to store and search; wider retrieves a little better.
                </p>
              </div>
            </div>
          </>
        )}
      </CardContent>
      <CardFooter className="gap-2">
        <Button onClick={() => void save()} disabled={busy || !changed}>Save</Button>
        <Button
          variant="secondary"
          onClick={() => void reembed()}
          disabled={busy || running || !status || status.upToDate}
        >
          {running ? 'Moving…' : 'Re-embed'}
        </Button>
      </CardFooter>
    </Card>
  );
}
