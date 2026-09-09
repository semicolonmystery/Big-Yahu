import { useEffect, useState } from 'react';
import type { DashboardStats } from '@shared/types';
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
