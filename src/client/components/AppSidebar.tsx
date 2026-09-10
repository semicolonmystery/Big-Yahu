import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Search, Settings, Puzzle, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/facts', label: 'Facts', icon: Search, end: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false },
  { to: '/plugins', label: 'Plugins', icon: Puzzle, end: false },
];

function AppSidebar() {
  const { status, logout } = useAuth();

  return (
    <aside className="flex h-screen w-14 shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground sm:w-56">
      <div className="px-2 py-4 text-center sm:px-4 sm:text-left">
        <span className="font-heading text-base font-semibold tracking-tight"><span className="sm:hidden" aria-hidden="true">BY</span><span className="sr-only sm:not-sr-only">Big Yahu</span></span>
      </div>
      <Separator />
      <nav aria-label="Main navigation" className="flex flex-1 flex-col gap-1 p-2">
        {navItems.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            title={label}
            className={({ isActive }) =>
              cn(
                'flex items-center justify-center gap-2 rounded-lg px-2 py-2 text-sm font-medium transition-colors sm:justify-start sm:px-3',
                isActive
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              )
            }
          >
            <Icon className="size-4" />
            <span className="sr-only sm:not-sr-only">{label}</span>
          </NavLink>
        ))}
      </nav>
      <Separator />
      <div className="flex items-center justify-center gap-2 p-2 sm:justify-between sm:p-3">
        <span className="hidden truncate text-sm text-muted-foreground sm:inline">{status?.username}</span>
        <Button variant="ghost" size="icon-sm" onClick={() => {
          void logout().catch((error: unknown) => toast.error(error instanceof Error ? error.message : 'Failed to log out'));
        }} aria-label="Log out">
          <LogOut className="size-4" />
        </Button>
      </div>
    </aside>
  );
}

export { AppSidebar };
