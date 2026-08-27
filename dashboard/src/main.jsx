import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/tokens.css';
import './index.css';

// BrowserRouter, not HashRouter: this console is served by Vite in dev and as
// static files behind the backend in production, and a dispatcher pasting a
// link to /weather into a colleague's chat should get the alerts page. That
// requires the server to fall back to index.html for unknown paths -- if the
// deploy target cannot do that, switch to HashRouter here rather than
// scattering hash-aware links through the components.
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
