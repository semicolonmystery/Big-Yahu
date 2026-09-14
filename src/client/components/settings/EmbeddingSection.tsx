import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import type { AppSettings, EmbeddingStatus } from '@shared/types';
import { api } from '@/lib/api';
import { useJobPolling } from '@/lib/useJobPolling';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

/** While a move is running, so the count is seen to climb rather than guessed at. */
const POLL_MS = 3000;

/** Keep asking while a move is running, so the count is seen to climb. */
const isRunning = (status: EmbeddingStatus) => status.job?.status === 'running';

export function EmbeddingSection() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<{ embeddingModel: string; embeddingDimensions: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const load = useCallback(async () => {
    const [next, current] = await Promise.all([api.embeddingStatus(), api.getSettings()]);
    setSettings(current);
    setDraft((existing) => existing ?? {
      embeddingModel: current.embeddingModel,
      embeddingDimensions: current.embeddingDimensions,
    });
    return next;
  }, []);

  const { value: status, error, refresh } = useJobPolling(load, isRunning, POLL_MS);

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
      await refresh();
      toast.success('Saved. Re-embed to move the facts across.');
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  const run = async (act: () => Promise<EmbeddingStatus>, done: string) => {
    setBusy(true);
    try {
      await act();
      // Reading it back is what starts the polling: the status says whether
      // anything is moving, and the poll follows the status rather than a timer
      // somebody has to remember to restart.
      await refresh();
      toast.success(done);
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  const job = status?.job;
  const running = job?.status === 'running';
  const stopped = job?.status === 'paused' || job?.status === 'failed';
  const unfinished = running || stopped;

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

            {job && unfinished ? (
              <div className="flex flex-col gap-2">
                <Progress value={job.total > 0 ? (job.copied / job.total) * 100 : 0} />
                <p className="text-xs text-muted-foreground">
                  {job.copied} of {job.total} moved to {job.targetModel}
                  {job.status === 'paused' ? ' — paused' : ''}
                  {job.pausesRecall ? ' — the bot remembers nothing until this finishes' : ''}
                </p>
                {job.status === 'failed' ? (
                  <Alert variant="destructive">
                    <AlertTitle>The move stopped</AlertTitle>
                    <AlertDescription>
                      {job.lastError ?? 'Unknown error'} &mdash; nothing was lost, and nothing was deleted.
                      Continue picks up where it stopped.
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

        {running ? (
          <Button variant="secondary" onClick={() => void run(api.pauseReembed, 'Paused.')} disabled={busy}>
            Pause
          </Button>
        ) : (
          <Button
            variant="secondary"
            onClick={() => void run(stopped ? api.continueReembed : api.startReembed, 'Moving the facts across.')}
            disabled={busy || !status || (status.upToDate && !stopped)}
          >
            {stopped ? 'Continue' : 'Re-embed'}
          </Button>
        )}

        {job && unfinished ? (
          <Button variant="ghost" onClick={() => setConfirmingReset(true)} disabled={busy}>
            Reset
          </Button>
        ) : null}
      </CardFooter>

      <Dialog open={confirmingReset} onOpenChange={setConfirmingReset}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Throw this move away?</DialogTitle>
            <DialogDescription>
              The {job?.copied ?? 0} fact{job?.copied === 1 ? '' : 's'} copied so far are removed from
              {' '}{job?.targetModel}. Your original facts are untouched &mdash; they have not been deleted at any
              point, and this puts things back exactly as they were before the move started.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmingReset(false)}>Keep going</Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setConfirmingReset(false);
                void run(api.resetReembed, 'The move was thrown away. Your facts are as they were.');
              }}
            >
              Reset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
