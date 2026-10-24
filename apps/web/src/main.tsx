import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './styles/global.css';
import { FeedbackHost } from './components/Feedback';
import { TooltipHost } from './components/Tooltip';
import { ToastHost } from './components/Toast';

// Replaced with a literal by Vite: the unused entry is eliminated at build time.
const App = __MOCK__
  ? lazy(() => import('./MockApp'))
  : lazy(() => import('./ProductionApp'));

const router = createBrowserRouter([
  {
    path: '*',
    element: (
      <>
        <Suspense fallback={<p>加载中…</p>}>
          <App />
        </Suspense>
        <FeedbackHost />
        <TooltipHost />
        <ToastHost />
      </>
    ),
  },
]);
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
