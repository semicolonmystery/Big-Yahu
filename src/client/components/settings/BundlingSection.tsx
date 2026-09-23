import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { AppSettings, BundlingStatus } from '@shared/types';

/**
 * Sending a channel's history in fixed groups so a provider can cache it.
 *
 * Its own card rather than another row in the behaviour list, because two of
 * the things an operator needs to know are conditional: whether the jobs that
 * share the history actually answer on the same model, and that changing the
 * size throws every bundle away.
 */
export function BundlingSection({
  draft, settings, onChange,
}: {
  draft: AppSettings | null;
  settings: AppSettings | null;
  onChange: (patch: Partial<AppSettings>) => void;
}) {
  const [status, setStatus] = useState<BundlingStatus | null>(null);
  const [pendingSize, setPendingSize] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.bundlingStatus()
      .then((next) => { if (!cancelled) setStatus(next); })
      .catch(() => { /* The controls still work; only the warning is missing. */ });
    return () => { cancelled = true; };
  }, [draft?.messageBundlingEnabled]);

  if (!draft || !settings) return null;

  // Asked before the change is made rather than after: what it costs is every
  // bundle in the table, and an accidental keystroke in a number field is
  // exactly how somebody would otherwise do it.
  const askAboutSize = (value: number) => {
    if (!Number.isFinite(value) || value === draft.messageBundleSize) return;
    if ((status?.bundles ?? 0) === 0) { onChange({ messageBundleSize: value }); return; }
    setPendingSize(value);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bundled history</CardTitle>
        <CardDescription>
          Sends the older part of a channel's history in fixed groups, cut at points that never move, so a request
          begins with the same bytes every time and the provider can charge cached rates for it. The trade is that
          a bundle is sent whole: needing one message out of five costs all five, cached.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-3">
            <Switch
              id="messageBundlingEnabled"
              checked={draft.messageBundlingEnabled}
              onCheckedChange={(checked) => onChange({ messageBundlingEnabled: checked })}
              aria-label="Toggle bundled history"
            />
            <Label htmlFor="messageBundlingEnabled">Bundle history for caching</Label>
          </div>
        </div>

        {draft.messageBundlingEnabled && status && status.differing.length > 0 && (
          <Alert>
            <AlertTitle>These will not share the cache</AlertTitle>
            <AlertDescription>
              A cached prefix belongs to one model on one host, and the reply, topic extraction and fact
              extraction all read the same history. On {status.sharedModel || 'the first model'} that history is
              cached once and reused; {status.differing.join(' and ')} {status.differing.length === 1 ? 'answers' : 'answer'}
              {' '}on something else, so {status.differing.length === 1 ? 'it' : 'they'} will pay full price for the
              same messages. Point all three at the same model to get the saving.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="messageBundleSize">Messages per bundle</Label>
          <Input
            id="messageBundleSize"
            type="number"
            min={2}
            max={50}
            className="max-w-xs"
            value={draft.messageBundleSize}
            onChange={(event) => askAboutSize(Number(event.target.value))}
          />
          <p className="text-xs text-muted-foreground">
            A bundle is sealed only once it can be filled exactly, so nothing is ever sent half-formed. Bigger
            bundles cache more at once and drag more unrelated history along with a single message.
            {status ? ` ${status.bundles} bundle${status.bundles === 1 ? '' : 's'} stored.` : ''}
          </p>
        </div>
      </CardContent>

      <Dialog open={pendingSize !== null} onOpenChange={(open) => { if (!open) setPendingSize(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Throw away every bundle?</DialogTitle>
            <DialogDescription>
              Bundles of one size cannot be told apart from another once stored, so changing this drops all
              {' '}{status?.bundles ?? 0} of them and they are cut again as channels talk. Nothing is lost but the
              cache hits — the messages themselves are untouched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Keep them</DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingSize !== null) onChange({ messageBundleSize: pendingSize });
                toast.success('Bundles will be cut again from scratch');
                setPendingSize(null);
              }}
            >
              Change the size
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
