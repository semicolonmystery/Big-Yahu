import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Search } from 'lucide-react';
import type { PluginCell, PluginPageData, PluginPageRow, PluginSummary } from '@shared/types';
import { MENTION_SPLIT, readMention } from '@shared/discord';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { renderPanelElement, statusBadgeVariant, textToneClass, panelFieldValues } from '@/lib/panelElements';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Pagination, PaginationContent, PaginationItem, PaginationPrevious, PaginationNext } from '@/components/ui/pagination';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

/** "5m ago" / "3h ago" / "2d ago" — the exact datetime is on the title tooltip instead. */
function relativeTime(at: number): string {
  const diffMs = Date.now() - at;
  const seconds = Math.round(diffMs / 1000);
  if (seconds < 60) return seconds <= 0 ? 'just now' : `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * A mention inside ordinary text, given the same chip as a `user` cell.
 *
 * A plugin stores people and channels as ids because that is what survives a
 * rename, so a rolling memory reads "<@1049…> spam emails sent to …". That is
 * right in storage and unreadable in a table, and the id is still on the tooltip
 * so it stays obvious that the id is what is stored.
 */
type TextTone = 'body' | 'muted' | 'success' | 'error';

function MentionedText({
  text,
  names,
  tone,
}: {
  text: string;
  names?: Record<string, string>;
  tone?: TextTone;
}) {
  if (!names) return <span className={textToneClass(tone)}>{text}</span>;

  return (
    <span className={textToneClass(tone)}>
      {text.split(MENTION_SPLIT).map((piece, index) => {
        if (index % 2 === 0) return piece;
        const { id, isChannel } = readMention(piece);
        const label = names[piece] ?? (isChannel ? `#${id}` : id);
        return (
          <span
            key={index}
            title={`${isChannel ? 'channel' : 'user'} id ${id}`}
            className="rounded bg-primary/10 px-1 font-medium text-primary"
          >
            {isChannel ? label : `@${label}`}
          </span>
        );
      })}
    </span>
  );
}

function PageCell({ cell }: { cell: PluginCell }) {
  switch (cell.kind) {
    case 'text':
      return <MentionedText text={cell.text} names={cell.mentions} tone={cell.tone} />;
    case 'user':
      // Same mention-chip treatment as the facts browser: a resolved name, id on the tooltip.
      return (
        <span title={`user id ${cell.id}`} className="rounded bg-primary/10 px-1 font-medium text-primary">
          @{cell.name}
        </span>
      );
    case 'channel':
      return <span className="text-muted-foreground">{cell.name}</span>;
    case 'number':
      return (
        <span className="tabular-nums">
          {cell.value}
          {cell.suffix ? ` ${cell.suffix}` : ''}
        </span>
      );
    case 'meter':
      return (
        <div className="flex items-center gap-2">
          <Progress value={Math.round(cell.value * 100)} className="w-24" />
          {cell.label && <span className="text-xs text-muted-foreground">{cell.label}</span>}
        </div>
      );
    case 'time':
      return <span title={new Date(cell.at).toLocaleString()}>{relativeTime(cell.at)}</span>;
    case 'badge':
      return <Badge variant={statusBadgeVariant(cell.tone)}>{cell.text}</Badge>;
    default:
      return null;
  }
}

interface ConfirmState {
  rowId: string;
  actionId: string;
  text: string;
  tone?: 'default' | 'destructive';
}

// Keyed by id pair in the default export below, so switching pages remounts cleanly instead of
// showing the previous page's stale rows under the new heading.
function PluginPageView({ pluginId, pageId }: { pluginId?: string; pageId?: string }) {
  const [plugin, setPlugin] = useState<PluginSummary | null>(null);
  const [metaLoading, setMetaLoading] = useState(true);
  const [metaError, setMetaError] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [data, setData] = useState<PluginPageData | null>(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);

  const [headerValues, setHeaderValues] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const pageSummary = plugin?.pages.find((p) => p.id === pageId) ?? null;

  useEffect(() => {
    if (!pluginId) return;
    let cancelled = false;
    api
      .listPlugins()
      .then((list) => {
        if (cancelled) return;
        setPlugin(list.find((p) => p.id === pluginId) ?? null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setMetaError(err instanceof Error ? err.message : 'Failed to load the plugin');
      })
      .finally(() => {
        if (!cancelled) setMetaLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pluginId]);

  useEffect(() => {
    // Both the debounced term and the page reset belong to the same user action (typing), so they
    // land together once the timer fires rather than as two separate synchronous effect updates.
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // Only the very first load shows a skeleton; a page or search change just swaps the rows in
  // place once the new ones arrive, the same way the facts browser does it.
  const fetchPage = useCallback(
    () => {
      if (!pluginId || !pageId) return;
      return api
        .pluginPage(pluginId, pageId, { page, pageSize: PAGE_SIZE, query: debouncedQuery })
        .then((result) => {
          setData(result);
          setHeaderValues(panelFieldValues({ elements: result.header ?? [] }));
          setDataError(null);
        })
        .catch((err: unknown) => {
          setDataError(err instanceof Error ? err.message : 'Failed to load this page');
        })
        .finally(() => setDataLoading(false));
    },
    [pluginId, pageId, page, debouncedQuery],
  );

  useEffect(() => {
    void fetchPage();
  }, [fetchPage]);

  const runAction = async (rowId: string, actionId: string) => {
    if (!pluginId || !pageId) return;
    setActionBusy(true);
    try {
      const result = await api.runPluginPageAction(pluginId, pageId, actionId, rowId);
      if (result.message) {
        if (result.tone === 'error') toast.error(result.message);
        else if (result.tone === 'success') toast.success(result.message);
        else toast(result.message);
      }
      setConfirm(null);
      await fetchPage();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionBusy(false);
    }
  };

  const handleActionClick = (row: PluginPageRow, action: NonNullable<PluginPageRow['actions']>[number]) => {
    if (action.confirm) {
      setConfirm({ rowId: row.id, actionId: action.actionId, text: action.confirm, tone: action.tone });
      return;
    }
    void runAction(row.id, action.actionId);
  };

  const hasActions = data?.rows.some((row) => (row.actions?.length ?? 0) > 0) ?? false;
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = data?.page ?? page;
  const rangeStart = total === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(currentPage * PAGE_SIZE, total);

  return (
    <div className="flex flex-col gap-6">
      <Link
        to="/plugins"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to plugins
      </Link>

      {metaLoading ? (
        <Skeleton className="h-8 w-64" />
      ) : metaError ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn't load this page</AlertTitle>
          <AlertDescription>{metaError}</AlertDescription>
        </Alert>
      ) : !pageSummary ? (
        <Alert variant="destructive">
          <AlertTitle>Page not found</AlertTitle>
          <AlertDescription>This plugin has no page by that id.</AlertDescription>
        </Alert>
      ) : (
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{pageSummary.title}</h1>
          {pageSummary.description && <p className="text-sm text-muted-foreground">{pageSummary.description}</p>}
        </div>
      )}

      {data?.header && data.header.length > 0 && (
        <div className="flex flex-col gap-3">
          {data.header.map((el, idx) =>
            renderPanelElement(el, idx, {
              values: headerValues,
              onFieldChange: (name, value) => setHeaderValues((current) => ({ ...current, [name]: value })),
              busy: false,
              // A header button acts on the page rather than on any one row, which
              // is what the empty row id says.
              onButtonClick: (button) => {
                if (button.confirm) {
                  setConfirm({ rowId: '', actionId: button.actionId, text: button.confirm, tone: button.tone });
                  return;
                }
                void runAction('', button.actionId);
              },
            }),
          )}
        </div>
      )}

      {data?.searchable && (
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search…"
            className="pl-8"
            aria-label="Search this page"
          />
        </div>
      )}

      {dataError && (
        <Alert variant="destructive">
          <AlertTitle>Couldn't load rows</AlertTitle>
          <AlertDescription>{dataError}</AlertDescription>
        </Alert>
      )}

      {dataLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : data && data.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{data.emptyMessage ?? 'Nothing to show.'}</p>
      ) : (
        data && (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  {data.columns.map((column) => (
                    <TableHead
                      key={column.key}
                      className={cn(column.align === 'right' && 'text-right', column.secondary && 'hidden md:table-cell')}
                    >
                      {column.label}
                    </TableHead>
                  ))}
                  {hasActions && <TableHead className="text-right" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((row) => (
                  <TableRow key={row.id}>
                    {data.columns.map((column) => (
                      <TableCell
                        key={column.key}
                        className={cn(column.align === 'right' && 'text-right', column.secondary && 'hidden md:table-cell')}
                      >
                        {row.cells[column.key] ? <PageCell cell={row.cells[column.key]} /> : null}
                      </TableCell>
                    ))}
                    {hasActions && (
                      <TableCell className="text-right">
                        <div className="flex flex-wrap justify-end gap-1">
                          {(row.actions ?? []).map((action) => (
                            <Button
                              key={action.actionId}
                              variant={action.tone === 'destructive' ? 'destructive' : 'outline'}
                              size="sm"
                              disabled={actionBusy}
                              onClick={() => handleActionClick(row, action)}
                            >
                              {action.label}
                            </Button>
                          ))}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
              <p className="text-sm text-muted-foreground">
                {total === 0 ? '0 results' : `Showing ${rangeStart}–${rangeEnd} of ${total}`}
              </p>
              <Pagination className="mx-0 w-fit">
                <PaginationContent>
                  <PaginationItem>
                    <PaginationPrevious
                      href="#"
                      onClick={(event) => {
                        event.preventDefault();
                        if (currentPage > 1) setPage(currentPage - 1);
                      }}
                      className={cn(currentPage <= 1 && 'pointer-events-none opacity-50')}
                    />
                  </PaginationItem>
                  <PaginationItem>
                    <span className="px-2 text-sm text-muted-foreground">
                      Page {currentPage} of {totalPages}
                    </span>
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationNext
                      href="#"
                      onClick={(event) => {
                        event.preventDefault();
                        if (currentPage < totalPages) setPage(currentPage + 1);
                      }}
                      className={cn(currentPage >= totalPages && 'pointer-events-none opacity-50')}
                    />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </div>
          </>
        )
      )}

      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Are you sure?</DialogTitle>
            <DialogDescription>{confirm?.text}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              variant={confirm?.tone === 'destructive' ? 'destructive' : 'default'}
              disabled={actionBusy}
              onClick={() => {
                if (confirm) void runAction(confirm.rowId, confirm.actionId);
              }}
            >
              {actionBusy ? 'Working…' : 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function PluginPage() {
  const { pluginId, pageId } = useParams<{ pluginId: string; pageId: string }>();
  return <PluginPageView key={`${pluginId}:${pageId}`} pluginId={pluginId} pageId={pageId} />;
}
