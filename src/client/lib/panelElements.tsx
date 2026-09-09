import type { PanelElement, PanelView } from '@shared/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';

export const statusBadgeVariant = (tone: 'ok' | 'warn' | 'error' | undefined) =>
  tone === 'error' ? 'destructive' : tone === 'warn' ? 'outline' : 'secondary';

export const textToneClass = (tone: 'body' | 'muted' | 'success' | 'error' | undefined) =>
  tone === 'error'
    ? 'text-destructive'
    : tone === 'muted'
      ? 'text-muted-foreground'
      : tone === 'success'
        ? 'font-medium text-foreground'
        : 'text-foreground';

export function panelFieldValues(view: PanelView): Record<string, string> {
  const values: Record<string, string> = {};
  for (const el of view.elements) {
    if (el.type === 'field') values[el.name] = el.value ?? '';
  }
  return values;
}

export interface PanelElementHandlers {
  values: Record<string, string>;
  onFieldChange: (name: string, value: string) => void;
  busy: boolean;
  onButtonClick: (el: Extract<PanelElement, { type: 'button' }>) => void;
}

/**
 * Shared by the plugin panel dialog and a plugin page's header — both carry
 * the same `PanelElement[]` vocabulary, so this is the one place it is turned
 * into markup.
 */
export function renderPanelElement(el: PanelElement, idx: number, handlers: PanelElementHandlers) {
  switch (el.type) {
    case 'heading':
      return (
        <h3 key={idx} className="text-sm font-semibold text-foreground">
          {el.text}
        </h3>
      );
    case 'text':
      return (
        <p key={idx} className={`text-sm ${textToneClass(el.tone)}`}>
          {el.text}
        </p>
      );
    case 'status':
      return (
        <div key={idx} className="flex items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">{el.label}</span>
          <Badge variant={statusBadgeVariant(el.tone)}>{el.value}</Badge>
        </div>
      );
    case 'image':
      return (
        <div key={idx} className="flex flex-col items-center gap-1.5">
          <img src={el.src} alt={el.alt ?? ''} className="max-h-64 max-w-full object-contain" />
          {el.caption && <p className="text-xs text-muted-foreground">{el.caption}</p>}
        </div>
      );
    case 'field':
      return (
        <div key={idx} className="flex flex-col gap-1.5">
          <Label htmlFor={`panel-field-${el.name}`}>{el.label}</Label>
          <Input
            id={`panel-field-${el.name}`}
            type={el.inputType ?? 'text'}
            placeholder={el.placeholder}
            value={handlers.values[el.name] ?? ''}
            onChange={(event) => handlers.onFieldChange(el.name, event.target.value)}
            disabled={handlers.busy}
          />
          {el.help && <p className="text-xs text-muted-foreground">{el.help}</p>}
        </div>
      );
    case 'button':
      return (
        <Button
          key={idx}
          variant={el.tone === 'destructive' ? 'destructive' : 'default'}
          disabled={handlers.busy}
          onClick={() => handlers.onButtonClick(el)}
        >
          {el.label}
        </Button>
      );
    case 'divider':
      return <Separator key={idx} />;
    default:
      return null;
  }
}
