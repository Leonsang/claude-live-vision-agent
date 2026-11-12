import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LiveVision } from '../src/react';
import '../src/react/styles.css';

const locale = navigator.language.toLowerCase().startsWith('es') ? 'es' : 'en';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LiveVision locale={locale} />
  </StrictMode>,
);
