import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { AuthGate } from './AuthGate.js';
import { AppearanceProvider } from './appearance.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppearanceProvider>
      <AuthGate>{({ authRequired, onSignOut }) => <App authRequired={authRequired} onSignOut={onSignOut} />}</AuthGate>
    </AppearanceProvider>
  </React.StrictMode>,
);
