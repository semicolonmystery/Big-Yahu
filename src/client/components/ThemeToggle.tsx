import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const CHOICES = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
] as const;

/**
 * Light, dark, or whatever the machine says.
 *
 * `next-themes` was already a dependency and the dark variables were already in
 * the stylesheet; nothing provided the theme, so the toaster's `useTheme` read a
 * default and the toggle did not exist. This is the provider's other half.
 *
 * The icon follows what is actually on screen rather than what is stored, so
 * "system" shows a sun or a moon depending on the machine. Until the theme is
 * resolved both values are undefined, which is the hydration guard and needs no
 * flag of its own.
 */
export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  // Both are undefined until the theme is known, which is the hydration guard
  // this needs and gets for free — no mounted flag, and nothing to flicker: the
  // icon simply starts as the light one and settles.
  const Icon = resolvedTheme === 'dark' ? Moon : Sun;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button variant="ghost" size="icon" aria-label="Theme">
            <Icon className="size-4" />
          </Button>
        )}
      />
      <DropdownMenuContent align="end">
        {CHOICES.map((choice) => (
          <DropdownMenuItem
            key={choice.value}
            onClick={() => setTheme(choice.value)}
            data-selected={theme === choice.value ? '' : undefined}
          >
            <choice.icon className="size-4" />
            {choice.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
