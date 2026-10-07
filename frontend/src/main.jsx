import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// /sala/<código>: videochamada, fora do login (o cliente entra só com o link). Carregada à parte:
// quem só usa o CRM não descarrega o código da sala, e o cliente não descarrega o CRM.
const MeetingRoom = lazy(() => import('./meet/MeetingRoom.jsx'));
const roomCode = /^\/sala\/([A-Za-z0-9_-]{6,32})\/?$/.exec(window.location.pathname)?.[1];

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {roomCode ? (
      <Suspense fallback={<div className="min-h-dvh bg-[#0e0e0e]" />}>
        <MeetingRoom code={roomCode} />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
