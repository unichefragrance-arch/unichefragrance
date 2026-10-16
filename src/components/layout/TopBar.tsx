"use client";

import { useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { Moon, Sun, Wifi, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { NotificationBell } from "@/components/layout/NotificationBell";
import { useTheme } from "@/components/theme/ThemeProvider";

const PAGE_TITLES: { href: string; label: string }[] = [
  { href: "/", label: "Dashboard" },
  { href: "/pos", label: "POS" },
  { href: "/inventory/low-stock", label: "Low Stock" },
  { href: "/inventory", label: "Inventory" },
  { href: "/formulas", label: "Formulas & BOM" },
  { href: "/production", label: "Production" },
  { href: "/purchases", label: "Purchasing" },
  { href: "/customers", label: "Customers" },
  { href: "/quotations", label: "Quotations" },
  { href: "/reports", label: "Reports" },
  { href: "/expenses", label: "Expenses" },
  { href: "/playground", label: "Playground" },
  { href: "/settings", label: "Settings" },
];

function resolvePageTitle(pathname: string, fallback?: string) {
  if (fallback) return fallback;
  const match = [...PAGE_TITLES]
    .sort((a, b) => b.href.length - a.href.length)
    .find((t) =>
      t.href === "/" ? pathname === "/" : pathname.startsWith(t.href),
    );
  return match?.label;
}

const noopSubscribe = () => () => {};

/** Browser connectivity: re-renders when the network drops or comes back. */
function subscribeOnline(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

export function TopBar({ title }: { title?: string }) {
  const pathname = usePathname();
  const pageTitle = resolvePageTitle(pathname, title);
  const { theme, toggleTheme } = useTheme();

  // ThemeProvider's initial state reads document.documentElement on mount,
  // which the blocking inline script may have already corrected to "light"
  // client-side — but SSR always assumes "dark" (no `document`). Render the
  // SSR-safe "dark" version until after mount so hydration always matches;
  // the real theme (if different) appears a frame later.
  const mounted = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  const resolvedTheme = mounted ? theme : "dark";
  // SSR has no network state — assume online until the browser says otherwise.
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-4 border-b border-line/70 bg-canvas/80 px-6 backdrop-blur-xl">
      <div className="flex min-w-0 items-center gap-3">
        {pageTitle ? (
          <p className="truncate text-sm font-semibold tracking-tight text-ink">
            {pageTitle}
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        {online ? (
          <Badge tone="success" className="hidden sm:inline-flex">
            <Wifi className="h-3 w-3" />
            Online
          </Badge>
        ) : (
          <Badge tone="danger" className="inline-flex">
            <WifiOff className="h-3 w-3" />
            Offline
          </Badge>
        )}
        <button
          type="button"
          onClick={toggleTheme}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-paper text-ink-muted transition hover:border-gold/40 hover:text-ink"
          aria-label={resolvedTheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={resolvedTheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {resolvedTheme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
        <NotificationBell />
      </div>
    </header>
  );
}
