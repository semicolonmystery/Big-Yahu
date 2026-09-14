import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import type { CleanupStatus } from '@shared/types';
import type { FactType } from '@shared/factTypes';

const UNTYPED = 'untyped';
const POLL_MS = 2000;

/**
 * The one-off pass over facts stored before the rules changed.
 *
 * It shares the re-embed's job runner, so it shares its controls: pause,
 * continue and reset act on whichever job is open. What it does not share is
 * starting — a cleanup chooses what it goes over, because running it across
 * `message` is the whole channel and running it across `rule` is an afternoon.
 */
export function FactCleanupSection({ types }: { types: FactType[] }) {
  const [status, setStatus] = useState<CleanupStatus | null>(null);
  const [chosen, setChosen] = useState<string[]>([UNTYPED]);
  const [bundleSize, setBundleSize] = useState(12);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Rebuilt when the chosen types change, which is exactly when the count it
  // reports has to change too.
  const load = useCallback(() => api.cleanupStatus(chosen), [chosen]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await load();
        if (cancelled) return;
        setStatus(next);
        setError(null);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Could not read the fact store');
      }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [load]);

  const run = async (act: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await act();
      setStatus(await load());
      toast.success(done);
    } catch (actError) {
      toast.error(actError instanceof Error ? actError.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  const job = status?.job ?? null;
  // A re-embed is the other job on this runner, and only one runs at a time.
  const otherJobOpen = job !== null && job.kind !== 'cleanup' && job.status !== 'complete';
  const running = job?.kind === 'cleanup' && job.status === 'running';
  const stopped = job?.kind === 'cleanup' && (job.status === 'paused' || job.status === 'failed');

  const toggle = (id: string) =>
    setChosen((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tidy up old facts</CardTitle>
        <CardDescription>
          Takes facts a bundle at a time and rewrites them under the rules the bot has since gained — real dates
          instead of "tomorrow", no dates it was never told, mentions instead of names, and a type on each.
          A fact it cannot improve comes back untouched. Nothing starts on its own.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {status === null && !error && <Skeleton className="h-24 w-full" />}

        {status !== null && (
          <>
            {status.untyped > 0 && (
              <Alert>
                <AlertDescription>
                  {status.untyped} fact{status.untyped === 1 ? '' : 's'} have no type yet. They come back from every
                  type search until this has sorted them.
                </AlertDescription>
              </Alert>
            )}

            <div className="flex flex-col gap-2">
              <Label>What to go over</Label>
              <div className="flex flex-col gap-2 rounded-lg border p-3">
                <label className="flex items-center justify-between gap-3 text-sm">
                  <span>Facts with no type yet</span>
                  <Switch checked={chosen.includes(UNTYPED)} onCheckedChange={() => toggle(UNTYPED)} disabled={running} />
                </label>
                {types.map((type) => (
                  <label key={type.id} className="flex items-center justify-between gap-3 text-sm">
                    <span>{type.label}</span>
                    <Switch checked={chosen.includes(type.id)} onCheckedChange={() => toggle(type.id)} disabled={running} />
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Choosing nothing goes over everything, which on a busy server means every message record too.
                This costs a model call per bundle, so start narrow.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cleanupBundleSize">Facts per call</Label>
              <Input
                id="cleanupBundleSize"
                type="number"
                min={1}
                max={50}
                className="w-32"
                value={bundleSize}
                disabled={running}
                onChange={(event) => setBundleSize(Number(event.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                Bigger bundles cost fewer calls; a bad answer then wastes more of one.
              </p>
            </div>

            <p className="text-sm text-muted-foreground">
              {status.facts} fact{status.facts === 1 ? '' : 's'} match that, in <code>{status.collection}</code>.
            </p>

            {job?.kind === 'cleanup' && job.status !== 'complete' && (
              <div className="flex flex-col gap-2">
                <Progress value={job.total > 0 ? (job.copied / job.total) * 100 : 0} />
                <p className="text-sm text-muted-foreground">
                  {job.copied} of {job.total} looked at — {job.status}
                </p>
                {job.lastError && (
                  <Alert variant="destructive"><AlertDescription>{job.lastError}</AlertDescription></Alert>
                )}
              </div>
            )}

            {otherJobOpen && (
              <Alert>
                <AlertDescription>
                  A re-embed is open, and only one job runs at a time. Finish or reset it first.
                </AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap gap-2">
              {!running && !stopped && (
                <Button
                  disabled={busy || otherJobOpen || status.facts === 0}
                  onClick={() => void run(() => api.startCleanup(chosen, bundleSize), 'Tidying up')}
                >
                  Tidy up {status.facts} fact{status.facts === 1 ? '' : 's'}
                </Button>
              )}
              {running && (
                <Button variant="outline" disabled={busy} onClick={() => void run(api.pauseReembed, 'Paused')}>
                  Pause
                </Button>
              )}
              {stopped && (
                <Button disabled={busy} onClick={() => void run(api.continueReembed, 'Carrying on')}>
                  Continue
                </Button>
              )}
              {(running || stopped) && (
                <Button variant="ghost" disabled={busy} onClick={() => void run(api.resetReembed, 'Stopped')}>
                  Stop and forget the rest
                </Button>
              )}
            </div>
            {(running || stopped) && (
              <p className="text-xs text-muted-foreground">
                Stopping keeps what it has already corrected — those facts were improved, and putting the old
                wording back would undo the work. It is safe to run again afterwards.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
