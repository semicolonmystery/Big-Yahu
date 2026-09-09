import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Search, Settings, Puzzle, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';

const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/facts', label: 'Facts', icon: Search, end: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false },
  { to: '/plugins', label: 'Plugins', icon: Puzzle, end: false },
];

function AppSidebar() {
  const { status, logout } = useAuth();

  return (
    <aside className="flex h-screen w-56 shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground">
      <div className="px-4 py-4">
        <span className="font-heading text-base font-semibold tracking-tight">Big Yahu</span>
      </div>
      <Separator />
      <nav className="flex flex-1 flex-col gap-1 p-2">
        {navItems.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              )
            }
          >
            <Icon className="size-4" />
            {label}
          </NavLink>
        ))}
      </nav>
      <Separator />
      <div className="flex items-center justify-between gap-2 p-3">
        <span className="truncate text-sm text-muted-foreground">{status?.username}</span>
        <Button variant="ghost" size="icon-sm" onClick={() => void logout()} aria-label="Log out">
          <LogOut className="size-4" />
        </Button>
      </div>
    </aside>
  );
}

export { AppSidebar };
