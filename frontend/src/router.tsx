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
  DuplicatesRouteView,
  FavoritesRouteView,
  FoldersRouteView,
  GalleryRouteView
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
    throw redirect({ to: user ? '/app/gallery' : '/login' });
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
      throw redirect({ to: '/app/gallery' });
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
    throw redirect({ to: '/app/gallery' });
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

const foldersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'folders',
  component: FoldersRouteView
});

const duplicatesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'duplicates',
  component: DuplicatesRouteView
});

const favoritesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'favorites',
  component: FavoritesRouteView
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  appRoute.addChildren([
    appIndexRoute,
    galleryRoute,
    foldersRoute,
    duplicatesRoute,
    favoritesRoute
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
