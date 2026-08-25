// Socket.IO client: telemetry out, reroutes in (MOB-01, MOB-07).
import { io } from 'socket.io-client';

export function connect({ apiUrl, truckId, onRouteUpdated, onIncident }) {
  const socket = io(apiUrl, {
    transports: ['websocket'],
    // The backend is often reachable only intermittently from a valley; let
    // the client keep trying rather than giving up after the default attempts.
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30_000,
    reconnectionAttempts: Infinity,
  });

  socket.on('connect', () => {
    // Rejoin on every reconnect, not just the first: room membership does not
    // survive a disconnect, and a truck that silently stops receiving
    // reroutes is the worst possible failure here.
    socket.emit('subscribe', { room: `truck:${truckId}` });
  });

  socket.on('route_updated', (payload) => onRouteUpdated?.(payload));
  socket.on('incident_reported', (payload) => onIncident?.(payload));

  return socket;
}
