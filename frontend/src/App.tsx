import { useQueryClient } from '@tanstack/react-query';

import { AppRouter } from '@/router';

function App() {
  const queryClient = useQueryClient();
  return <AppRouter queryClient={queryClient} />;
}

export default App;
