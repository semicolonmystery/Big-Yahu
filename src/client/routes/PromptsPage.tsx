import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Upload, RotateCcw, Lock } from 'lucide-react';
import type { PromptSummary } from '@shared/types';
import { api } from '@/lib/api';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
  DialogTrigger,
} from '@/components/ui/dialog';

/** What the editor holds for one prompt, against what the server last confirmed. */
interface Draft {
  text: string;
  saving: boolean;
}

function PromptCard({
  prompt,
  onChanged,
}: {
  prompt: PromptSummary;
  onChanged: () => Promise<void>;
}) {
  const current = prompt.override ?? prompt.shipped;
  // Keyed on `current` by the parent, so a save, reset or upload remounts this
  // with the server's text rather than an effect racing the editor.
  const [draft, setDraft] = useState<Draft>({ text: current, saving: false });
  const fileInput = useRef<HTMLInputElement>(null);

  const customised = prompt.override !== null;
  const dirty = draft.text !== current;

  const run = async (work: () => Promise<unknown>, success: string) => {
    setDraft((previous) => ({ ...previous, saving: true }));
    try {
      await work();
      await onChanged();
      toast.success(success);
    } catch (error) {
      // The server's rejection says which placeholder is missing, so show it verbatim.
      toast.error(error instanceof Error ? error.message : 'That did not work');
      setDraft((previous) => ({ ...previous, saving: false }));
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{prompt.label}</CardTitle>
          <Badge variant={customised ? 'default' : 'secondary'}>
            {customised ? 'Yours' : 'Shipped default'}
          </Badge>
        </div>
        <CardDescription>{prompt.description}</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {prompt.placeholders.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Replaced when the bot runs:</span>
            {prompt.placeholders.map((name) => (
              <code key={name} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{`{{${name}}}`}</code>
            ))}
            <span>— it will not save without them.</span>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`prompt-${prompt.id}`} className="sr-only">{prompt.label}</Label>
          <Textarea
            id={`prompt-${prompt.id}`}
            className="min-h-[22rem] font-mono text-xs leading-relaxed"
            spellCheck={false}
            value={draft.text}
            onChange={(event) => setDraft({ ...draft, text: event.target.value })}
          />
        </div>

        {prompt.floor && (
          <Alert>
            <Lock className="h-4 w-4" />
            <AlertTitle>Always added to the end of this prompt</AlertTitle>
            <AlertDescription>
              <p className="mb-2 text-xs">
                Not part of the text above and not removed by rewriting or uploading over it.
              </p>
              <p className="text-xs italic">{prompt.floor}</p>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>

      <CardFooter className="flex flex-wrap gap-2">
        <Button
          disabled={draft.saving || !dirty}
          onClick={() => void run(() => api.savePrompt(prompt.id, draft.text), `${prompt.label} saved`)}
        >
          {draft.saving ? 'Saving…' : 'Save'}
        </Button>

        <Button variant="outline" disabled={!dirty || draft.saving} onClick={() => setDraft({ text: current, saving: false })}>
          Discard changes
        </Button>

        <Button variant="outline" disabled={draft.saving} onClick={() => fileInput.current?.click()}>
          <Upload className="h-4 w-4" />
          Upload a file
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".txt,.md,text/plain,text/markdown"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void run(() => api.uploadPrompt(prompt.id, file), `${prompt.label} replaced from ${file.name}`);
          }}
        />

        {customised && (
          <Dialog>
            <DialogTrigger render={<Button variant="ghost" className="ml-auto text-destructive" />}>
              <RotateCcw className="h-4 w-4" />
              Reset to shipped
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Reset {prompt.label}?</DialogTitle>
                <DialogDescription>
                  Your version is deleted and the bot goes back to the one that ships with it — which also means
                  it picks up improvements to that text from here on. This cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
                <DialogClose
                  render={<Button variant="destructive" />}
                  onClick={() => void run(() => api.resetPrompt(prompt.id), `${prompt.label} reset`)}
                >
                  Reset
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </CardFooter>
    </Card>
  );
}

export default function PromptsPage() {
  const [prompts, setPrompts] = useState<PromptSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (): Promise<void> =>
      api
        .prompts()
        .then((data) => {
          setPrompts(data);
          setError(null);
        })
        .catch((caught: unknown) => {
          setError(caught instanceof Error ? caught.message : 'Failed to load the prompts');
        }),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Prompts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What the bot is told before every call. Rewriting these changes how it reads a channel and how it
          talks, immediately and on the next message — there is no restart and no deploy.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the prompts</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {prompts === null && !error && (
        <div className="flex flex-col gap-6">
          <Skeleton className="h-96 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      )}

      {prompts?.map((prompt) => (
        <PromptCard
          key={`${prompt.id}:${prompt.override ?? ''}`}
          prompt={prompt}
          onChanged={load}
        />
      ))}
    </div>
  );
}
