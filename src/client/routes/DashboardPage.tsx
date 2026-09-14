import { useEffect, useState } from 'react';
import type { AiUsageSummary, AiUsageTotals, DashboardStats } from '@shared/types';
import { api } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function truncate(text: string, maxLength = 120): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

/** Most calls cost fractions of a cent, so small amounts keep four places instead of reading as $0.00. */
function formatCost(cost: number): string {
  return `$${cost.toFixed(cost > 0 && cost < 0.01 ? 4 : 2)}`;
}

function cachedShare(totals: AiUsageTotals): string {
  return totals.promptTokens > 0 ? `${Math.round((totals.cachedTokens / totals.promptTokens) * 100)}%` : '—';
}

function UsageStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold text-foreground">{value}</span>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </div>
  );
}

function UsageTable({ title, groups }: { title: string; groups: AiUsageSummary['byTask'] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{title}</TableHead>
          <TableHead className="text-right">Calls</TableHead>
          <TableHead className="text-right">Cached input</TableHead>
          <TableHead className="text-right">Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => (
          <TableRow key={group.key}>
            <TableCell>{group.key}</TableCell>
            <TableCell className="text-right">
              {group.calls}
              {group.failures > 0 && <span className="text-muted-foreground"> ({group.failures} failed)</span>}
            </TableCell>
            <TableCell className="text-right">{cachedShare(group)}</TableCell>
            <TableCell className="text-right">{formatCost(group.cost)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * Loaded on its own rather than folded into the stats call, so a problem here
 * never takes the rest of the dashboard with it.
 */
function AiUsageCard() {
  const [usage, setUsage] = useState<AiUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .aiUsage()
      .then((data) => {
        if (!cancelled) setUsage(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load AI usage');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI spend</CardTitle>
        <CardDescription>
          What OpenRouter billed for each model call, with peak pricing and cache discounts already included.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !usage ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <UsageStat label="Last 24 hours" value={formatCost(usage.day.cost)} detail={`${usage.day.calls} calls`} />
              <UsageStat
                label="Last 7 days"
                value={formatCost(usage.week.cost)}
                detail={`${usage.week.calls} calls${usage.week.failures > 0 ? `, ${usage.week.failures} failed` : ''}`}
              />
              <UsageStat label="Cached input, 7 days" value={cachedShare(usage.week)} detail="of all prompt tokens" />
            </div>
            {usage.byTask.length === 0 ? (
              <p className="text-sm text-muted-foreground">No model calls recorded yet.</p>
            ) : (
              <>
                <UsageTable title="Task, last 7 days" groups={usage.byTask} />
                <UsageTable title="Model" groups={usage.byModel} />
                <p className="text-sm text-muted-foreground">
                  Served by {usage.byProvider.map((group) => `${group.key} (${group.calls})`).join(', ')}.
                </p>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .stats()
      .then((data) => {
        if (!cancelled) setStats(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load stats');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Dashboard</h1>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Couldn't load dashboard</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {loading ? (
          <>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardDescription>Total facts</CardDescription>
                <CardTitle className="text-3xl">{stats?.totalFacts ?? 0}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Messages referenced</CardDescription>
                <CardTitle className="text-3xl">{stats?.totalMessagesReferenced ?? 0}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Total replies</CardDescription>
                <CardTitle className="text-3xl">{stats?.totalReplies ?? 0}</CardTitle>
              </CardHeader>
            </Card>
          </>
        )}
      </div>

      <AiUsageCard />

      <Card>
        <CardHeader>
          <CardTitle>Latest replies</CardTitle>
          <CardDescription>The 5 most recent replies the bot has sent.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : !stats || stats.latestReplies.length === 0 ? (
            <p className="text-sm text-muted-foreground">No replies yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Reply</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.latestReplies.slice(0, 5).map((reply) => (
                  <TableRow key={reply.id}>
                    <TableCell className="text-muted-foreground">
                      {reply.jumpLink ? (
                        <a
                          href={reply.jumpLink}
                          target="_blank"
                          rel="noreferrer"
                          className="underline underline-offset-2 hover:text-foreground"
                        >
                          {formatDateTime(reply.createdAt)}
                        </a>
                      ) : (
                        formatDateTime(reply.createdAt)
                      )}
                    </TableCell>
                    <TableCell>{reply.userId}</TableCell>
                    <TableCell className="max-w-md whitespace-normal" title={reply.content}>
                      {truncate(reply.content)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
