import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { AuthGate } from './AuthGate.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate>{({ authRequired, onSignOut }) => <App authRequired={authRequired} onSignOut={onSignOut} />}</AuthGate>
  </React.StrictMode>,
);
