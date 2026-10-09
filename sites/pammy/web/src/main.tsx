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

// Links from before the pages had addresses (#messages, #help?q=...), and from
// before contact forms became Forms.
const OLD = { home: '/', sites: '/subdomains', protected: '/protected-folders', contact: '/forms', 'contact-forms': '/forms', messages: '/responses' } as Record<string, string>;
const PAGES = ['people', 'requests', 'forms', 'responses', 'media', 'passkeys', 'accounts', 'activity', 'help'];
if (location.pathname === '/' && /^#[a-z]/.test(location.hash)) {
  const [path = '', query] = location.hash.slice(1).split('?');
  const name = path.split('/')[0]!;
  const page = OLD[name] ?? (PAGES.includes(name) ? `/${name}` : '/');
  const q = new URLSearchParams(query || '');
  history.replaceState(null, '', `${page}${q.size ? `?${q}` : ''}`);
}

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
