import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { OrganizationSwitcher } from './OrganizationSwitcher';
import { ErrorBoundary } from './ErrorBoundary';

const ORG_NAV_ITEMS = [
  { to: '/devices', label: 'Screens', icon: '🖥' },
  { to: '/monitoring', label: 'Monitoring', icon: '📈' },
  { to: '/media', label: 'Media', icon: '🖼' },
  { to: '/playlists', label: 'Playlists', icon: '🎞' },
  { to: '/schedules', label: 'Schedules', icon: '🗓' },
  { to: '/emergency', label: 'Emergency', icon: '🚨' },
];

const navClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
    isActive ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800/60'
  }`;

/**
 * App shell.
 *
 * The sidebar is permanent from `lg` up and an off-canvas drawer below it. The
 * breakpoint is `lg`, not `md`: at 768px a 240px sidebar leaves 528px of
 * content, which is worse than a drawer plus the full width.
 */
export function Layout() {
  const { user, orgId, isSystemContext, logout } = useAuth();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);

  // Navigating is the whole point of opening the drawer, so it closes itself.
  useEffect(() => setNavOpen(false), [location.pathname]);

  // Without this the page scrolls behind the drawer under a touch drag, which
  // reads as the app losing its place.
  useEffect(() => {
    if (!navOpen) return;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [navOpen]);

  return (
    <div className="flex min-h-screen">
      {/* Backdrop: only rendered as a drawer, never at lg where the nav is
          permanent and nothing should dim the page. */}
      {navOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-30 cursor-default bg-slate-900/50 lg:hidden"
        />
      ) : null}

      <aside
        // `lg:transform-none`, not `lg:translate-x-0`: Tailwind's translate
        // utilities emit a `transform`, and a transformed ancestor becomes the
        // containing block for `position: fixed` descendants. Leaving one in
        // place at desktop would quietly scope OrganizationSwitcher's
        // click-outside backdrop to the sidebar instead of the viewport.
        className={`fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col overflow-y-auto bg-slate-900 text-slate-200 transition-transform duration-200 lg:static lg:transform-none ${
          navOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-start justify-between px-4 py-4">
          <div>
            <div className="text-lg font-bold text-white">Signage</div>
            <div className="text-xs text-slate-400">Digital signage console</div>
          </div>
          <button
            type="button"
            onClick={() => setNavOpen(false)}
            aria-label="Close navigation"
            className="-mr-1 px-1 text-slate-400 hover:text-white lg:hidden"
          >
            ✕
          </button>
        </div>

        <OrganizationSwitcher />

        {isSystemContext ? (
          <div className="mx-3 mb-2 rounded-md border border-amber-700/40 bg-amber-900/20 px-2.5 py-2 text-xs text-amber-200">
            You are in <span className="font-semibold">System / Superadmin</span> context. Select an
            organization to manage its screens and media.
          </div>
        ) : null}

        <nav className="flex-1 space-y-0.5 px-2">
          {/* Org-scoped navigation is hidden in superadmin system context. */}
          {!isSystemContext
            ? ORG_NAV_ITEMS.map((item) => (
                <NavLink key={item.to} to={item.to} className={navClass}>
                  <span aria-hidden>{item.icon}</span>
                  {item.label}
                </NavLink>
              ))
            : null}

          <NavLink to="/settings" className={navClass}>
            <span aria-hidden>⚙️</span>
            Settings
          </NavLink>

          {user?.globalRole === 'superadmin' ? (
            <>
              <div className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Superadmin
              </div>
              <NavLink to="/superadmin" end className={navClass}>
                <span aria-hidden>🏢</span>
                Companies
              </NavLink>
              <NavLink to="/superadmin/users" className={navClass}>
                <span aria-hidden>👥</span>
                Users
              </NavLink>
            </>
          ) : null}
        </nav>

        <div className="border-t border-slate-800 px-4 py-3">
          <div className="truncate text-sm text-slate-300">{user?.name}</div>
          <div className="truncate text-xs text-slate-500">{user?.email}</div>
          <button
            onClick={logout}
            className="mt-2 text-xs font-medium text-slate-400 hover:text-white"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* min-w-0 is what lets the table scroll containers inside shrink below
          their content width instead of stretching the page sideways. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5 lg:hidden">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
            aria-expanded={navOpen}
            className="-ml-1 rounded-md p-1.5 text-xl leading-none text-slate-600 hover:bg-slate-100"
          >
            ☰
          </button>
          <span className="truncate font-semibold text-slate-900">Signage</span>
        </header>

        <main className="min-w-0 flex-1 p-4 sm:p-6">
          {/* Remount on org switch / navigation: clears stale data and any error. */}
          <ErrorBoundary resetKey={`${orgId ?? 'system'}:${location.pathname}`}>
            <div key={orgId ?? 'system'}>
              <Outlet />
            </div>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
