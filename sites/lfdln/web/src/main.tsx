import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setNonce } from 'get-nonce';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ApiError, friendlyError, signedOut } from '@panel/core/web/lib/api';
import { notify } from '@panel/core/web/lib/status';
import './index.css';

// The page's nonce (the server makes a new one each time): the only way a
// <style> added while the panel runs (the dialogs add one) is allowed.
const nonce = document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.nonce;
if (nonce) setNonce(nonce);

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true, staleTime: 5_000 } },
  queryCache: new QueryCache({
    onError: (err, query) => {
      if (err instanceof ApiError && err.status === 401) return signedOut();
      if (query.meta?.quiet) return;          // the page shows it itself
      notify(friendlyError(err), 'error');
    },
  }),
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
