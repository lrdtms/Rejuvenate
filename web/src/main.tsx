import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Design-system tokens must be first so CSS custom properties are defined
// before any component stylesheet that references them.
import '@/design-system/tokens.css';
import '@/design-system/global.css';
// Per-component CSS is imported by each component's own file.

import { Providers } from '@/app/providers';
import { Router } from '@/app/router';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers>
      <Router />
    </Providers>
  </StrictMode>,
);
