// Socket.IO client: telemetry out, reroutes in (MOB-01, MOB-07).
import { io } from 'socket.io-client';

export function connect({
  apiUrl, truckId, onRouteUpdated, onIncident, onConnected, onDisconnected,
}) {
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
    onConnected?.();
  });

  // The link indicator must follow THIS socket, not general internet
  // reachability. A phone with four bars of 4G and no route to dispatch is
  // the exact case the driver has to be told about, and NetInfo calls it
  // online. connect_error counts as down too: socket.io retries forever, so
  // without it a server that is simply not there never reports anything.
  socket.on('disconnect', (reason) => onDisconnected?.(reason));
  socket.on('connect_error', (error) => onDisconnected?.(error.message));

  socket.on('route_updated', (payload) => onRouteUpdated?.(payload));
  socket.on('incident_reported', (payload) => onIncident?.(payload));

  return socket;
}
