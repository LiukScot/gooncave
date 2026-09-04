import type { QueryClient } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect
} from '@tanstack/react-router';

import { api, type AuthUser } from '@/api';
import { LoginRoute } from '@/features/auth/LoginRoute';
import {
  ExploreRouteView,
  GalleryRouteView,
  GamesRouteView,
  SettingsAccountsRouteView,
  SettingsBlacklistRouteView,
  SettingsDuplicatesRouteView,
  SettingsExtraRouteView,
  SettingsFileSourcesRouteView,
  SettingsFoldersRouteView,
  SettingsIndexRouteView,
  SettingsRouteView,
  SettingsShortcutsRouteView,
} from '@/features/shell/AppRoutes';
import { AppShell } from '@/features/shell/AppShell';
import { queryKeys } from '@/lib/query-keys';

type RouterContext = {
  queryClient: QueryClient;
};

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />
});

const loadCurrentUser = async (
  queryClient: QueryClient
): Promise<AuthUser | null> =>
  queryClient.ensureQueryData({
    queryKey: queryKeys.auth.me(),
    queryFn: async () => {
      try {
        return await api.getCurrentUser();
      } catch {
        return null;
      }
    },
    staleTime: 60_000
  });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async ({ context }) => {
    const user = await loadCurrentUser(context.queryClient);
    throw user
      ? redirect({
          to: '/app/gallery',
          search: { fileId: undefined, fs: undefined }
        })
      : redirect({ to: '/login', search: { redirect: undefined } });
  }
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined
  }),
  beforeLoad: async ({ context }) => {
    const user = await loadCurrentUser(context.queryClient);
    if (user) {
      throw redirect({
        to: '/app/gallery',
        search: { fileId: undefined, fs: undefined }
      });
    }
  },
  component: LoginRoute
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/app',
  beforeLoad: async ({ context, location }) => {
    const user = await loadCurrentUser(context.queryClient);
    if (!user) {
      throw redirect({
        to: '/login',
        search: {
          redirect: location.href
        }
      });
    }
  },
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

const settingsFoldersRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'folders',
  component: SettingsFoldersRouteView
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

const settingsExtraRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'extra',
  component: SettingsExtraRouteView
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  appRoute.addChildren([
    appIndexRoute,
    galleryRoute,
    exploreRoute,
    gamesRoute,
    settingsRoute.addChildren([
      settingsIndexRoute,
      settingsFoldersRoute,
      settingsFileSourcesRoute,
      settingsDuplicatesRoute,
      settingsAccountsRoute,
      settingsShortcutsRoute,
      settingsBlacklistRoute,
      settingsExtraRoute
    ])
  ])
]);

export const router = createRouter({
  routeTree,
  context: {
    queryClient: undefined!
  }
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function AppRouter({ queryClient }: { queryClient: QueryClient }) {
  return <RouterProvider router={router} context={{ queryClient }} />;
}
