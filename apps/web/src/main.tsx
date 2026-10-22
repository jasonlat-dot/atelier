import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './styles/global.css';

// Replaced with a literal by Vite: the unused entry is eliminated at build time.
const App = __MOCK__
  ? lazy(() => import('./MockApp'))
  : lazy(() => import('./ProductionApp'));

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Suspense fallback={<p>加载中…</p>}>
        <App />
      </Suspense>
    </BrowserRouter>
  </React.StrictMode>,
);
