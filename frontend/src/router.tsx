import type { QueryClient } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect
} from '@tanstack/react-router';

import {
  ExploreRouteView,
  GalleryRouteView,
  GamesRouteView,
  PoolRouteView,
  SettingsAccountsRouteView,
  SettingsAppearanceRouteView,
  SettingsBlacklistRouteView,
  SettingsDuplicatesRouteView,
  SettingsExtraRouteView,
  SettingsFileSourcesRouteView,
  SettingsIndexRouteView,
  SettingsRouteView,
  SettingsShortcutsRouteView,
  SettingsSubscriptionsRouteView,
  SettingsSyncRouteView,
  SettingsTrashRouteView,
} from '@/features/shell/AppRoutes';
import { AppShell } from '@/features/shell/AppShell';
import { isSwipeBackRunning } from '@/lib/edgeSwipeBack';
import {
  supportsViewTransitions,
  tabTransitionTypes
} from '@/lib/viewTransitions';

type RouterContext = {
  queryClient: QueryClient;
};

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/app/gallery', search: { fileId: undefined, fs: undefined } });
  }
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/app',
  component: AppShell
});

const appIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({
      to: '/app/gallery',
      search: { fileId: undefined, fs: undefined }
    });
  }
});

const galleryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'gallery',
  validateSearch: (search: Record<string, unknown>) => ({
    fileId: typeof search.fileId === 'string' ? search.fileId : undefined,
    // Fullscreen lives in the URL so the phone's back gesture exits it
    // instead of leaving the file altogether.
    fs: search.fs === true || search.fs === 'true' ? true : undefined
  }),
  component: GalleryRouteView
});

const exploreRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'explore',
  // The open post lives in the URL for the same reason the gallery's file
  // does: without it the browser's back button leaves the page entirely
  // instead of returning to the results.
  validateSearch: (search: Record<string, unknown>) => ({
    post: typeof search.post === 'string' ? search.post : undefined
  }),
  component: ExploreRouteView
});

// A pool is remote data, but it is not explore: no sorts, no site merge, no
// tag search — one set of posts in the booru's own order.
const poolRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'pool',
  validateSearch: (search: Record<string, unknown>) => ({
    site: typeof search.site === 'string' ? search.site : '',
    pool: typeof search.pool === 'string' ? search.pool : ''
  }),
  component: PoolRouteView
});

const gamesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'games',
  component: GamesRouteView
});

// Layout route: owns the /app/settings/* URL space and renders whichever
// child matched into its own <Outlet/>, so each subgroup below is a real,
// independently-linkable page instead of one long scrolling settings view.
const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'settings',
  component: SettingsRouteView
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/',
  component: SettingsIndexRouteView
});

const settingsFileSourcesRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'file-sources',
  component: SettingsFileSourcesRouteView
});

const settingsDuplicatesRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'duplicates',
  component: SettingsDuplicatesRouteView
});

const settingsAccountsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'accounts',
  component: SettingsAccountsRouteView
});

const settingsSubscriptionsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'subscriptions',
  component: SettingsSubscriptionsRouteView
});

const settingsShortcutsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'shortcuts',
  component: SettingsShortcutsRouteView
});

const settingsBlacklistRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'blacklist',
  component: SettingsBlacklistRouteView
});

const settingsAppearanceRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'appearance',
  component: SettingsAppearanceRouteView
});

const settingsSyncRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'sync',
  component: SettingsSyncRouteView
});

const settingsTrashRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'trash',
  component: SettingsTrashRouteView
});

const settingsExtraRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'extra',
  component: SettingsExtraRouteView
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  appRoute.addChildren([
    appIndexRoute,
    galleryRoute,
    exploreRoute,
    poolRoute,
    gamesRoute,
    settingsRoute.addChildren([
      settingsIndexRoute,
      settingsFileSourcesRoute,
      settingsDuplicatesRoute,
      settingsAccountsRoute,
      settingsSubscriptionsRoute,
      settingsShortcutsRoute,
      settingsBlacklistRoute,
      settingsAppearanceRoute,
      settingsSyncRoute,
      settingsExtraRoute,
      settingsTrashRoute
    ])
  ])
]);

export const router = createRouter({
  routeTree,
  context: {
    queryClient: undefined!
  },
  // Without typed transitions the router would animate every URL change,
  // filters included, so those browsers get none.
  defaultViewTransition: supportsViewTransitions
    ? {
        types: ({ fromLocation, toLocation }) =>
          isSwipeBackRunning()
            ? false
            : tabTransitionTypes(fromLocation, toLocation)
      }
    : false
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function AppRouter({ queryClient }: { queryClient: QueryClient }) {
  return <RouterProvider router={router} context={{ queryClient }} />;
}
