import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { AuthProvider } from '@/components/AuthProvider';
import { SetupDialog } from '@/components/SetupDialog';
import { AppSidebar } from '@/components/AppSidebar';
import { Toaster } from '@/components/ui/sonner';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import LoginPage from '@/routes/LoginPage';
import DashboardPage from '@/routes/DashboardPage';
const FactsSearchPage = lazy(() => import('@/routes/FactsSearchPage'));
const SettingsPage = lazy(() => import('@/routes/SettingsPage'));
const PluginsPage = lazy(() => import('@/routes/PluginsPage'));
const PluginPage = lazy(() => import('@/routes/PluginPage'));

function AppShell() {
  return (
    <BrowserRouter>
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        <AppSidebar />
        <main className="min-w-0 flex-1 overflow-y-auto p-3 sm:p-6">
          <Suspense fallback={<Skeleton className="h-32 w-full" />}>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/facts" element={<FactsSearchPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/plugins" element={<PluginsPage />} />
            <Route path="/plugins/:pluginId/:pageId" element={<PluginPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </Suspense>
        </main>
      </div>
    </BrowserRouter>
  );
}

function AppContent() {
  const { status, loading, error, refresh } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-4 w-56" />
      </div>
    );
  }

  if (!status) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="flex w-full max-w-md flex-col gap-4">
          <Alert variant="destructive">
            <AlertTitle>Couldn't connect to the admin panel</AlertTitle>
            <AlertDescription>{error ?? 'Authentication status is unavailable.'}</AlertDescription>
          </Alert>
          <Button onClick={() => void refresh()}>Try again</Button>
        </div>
      </div>
    );
  }

  if (!status.hasAdmin) {
    return <SetupDialog />;
  }

  if (!status.authenticated) {
    return <LoginPage />;
  }

  return <AppShell />;
}

function App() {
  return (
    <AuthProvider>
      <AppContent />
      <Toaster />
    </AuthProvider>
  );
}

export default App;
