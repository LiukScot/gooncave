import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

import { api } from '@/api';
import { queryKeys } from '@/lib/query-keys';

const TOAST_ID = 'library-repair';
const POLL_MS = 3000;

/** Tells the reader while the core repairs favorite links that point at the wrong file. */
export function useLibraryRepairNotice() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: queryKeys.duplicates.libraryRepair(),
    queryFn: () => api.getLibraryRepair(),
    refetchInterval: (query) => (query.state.data?.running ? POLL_MS : false)
  });
  const wasRunning = useRef(false);
  const running = data?.running === true;

  useEffect(() => {
    if (running) {
      wasRunning.current = true;
      toast.info("We're fixing some errors in the database.", {
        id: TOAST_ID,
        duration: Infinity,
        description: 'Some favorites may change while this runs. It happens once.'
      });
      return;
    }
    if (!wasRunning.current) return;
    wasRunning.current = false;
    toast.dismiss(TOAST_ID);
    queryClient.invalidateQueries({ queryKey: queryKeys.files.all });
    // Explore marks a post as saved from these links.
    queryClient.invalidateQueries({ queryKey: ['explore'] });
  }, [running, queryClient]);
}
