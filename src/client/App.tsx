import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { SetupDialog } from '@/components/SetupDialog';
import { AppSidebar } from '@/components/AppSidebar';
import { Toaster } from '@/components/ui/sonner';
import { Skeleton } from '@/components/ui/skeleton';
import LoginPage from '@/routes/LoginPage';
import DashboardPage from '@/routes/DashboardPage';
import FactsSearchPage from '@/routes/FactsSearchPage';
import SettingsPage from '@/routes/SettingsPage';
import PluginsPage from '@/routes/PluginsPage';
import PluginPage from '@/routes/PluginPage';

function AppShell() {
  return (
    <BrowserRouter>
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        <AppSidebar />
        <main className="flex-1 overflow-y-auto p-6">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/facts" element={<FactsSearchPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/plugins" element={<PluginsPage />} />
            <Route path="/plugins/:pluginId/:pageId" element={<PluginPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

function AppContent() {
  const { status, loading } = useAuth();

  if (loading || !status) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-4 w-56" />
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
