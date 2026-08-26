// The single Socket.IO connection, and the frame loop that animates it.
//
// Mount this ONCE, at the top of the tree. Every component below reads the
// results out of commandStore with a selector; none of them opens a socket of
// its own. That is the whole reason the store exists -- four panels each
// holding their own `io()` would each receive a different subset of packets
// and disagree about the fleet on screen.
//
// -------------------------------------------------------------------------
// SYNC WITH THE MOBILE CLIENT
// -------------------------------------------------------------------------
// The driver's app (mobile-app/src/services/socket.js) joins `truck:<id>` and
// listens for `route_updated` and `incident_reported`. This dashboard joins
// `dispatchers` and listens for those same two events plus
// `truck_location_update`. Both sides therefore converge on the same three
// server-owned events, and neither invents a private one -- so a reroute the
// dispatcher triggers is the identical payload the phone speaks aloud through
// Bhashini.
//
// One event in this file is NOT yet server-owned: `burst_sync_complete`. The
// BullMQ worker already computes exactly the payload needed and already takes
// an `onCompleted` callback, but `startBurstSyncWorker()` is called with no
// arguments at its CLI entry point, and `recordTelemetry()` writes to the
// database without going through the socket fan-out. So burst-synced points
// reach PostGIS and never reach this screen. The listener below is wired and
// correct; it stays silent until the backend emits. See the report notes --
// closing it is a backend change, which this task is not permitted to make.
import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { API_URL } from '../lib/api';
import { useCommandStore, positionStore } from '../store/commandStore';

export const DISPATCHER_ROOM = 'dispatchers';

export function useCommandSocket() {
  useEffect(() => {
    const store = useCommandStore.getState();

    const socket = io(API_URL, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      reconnectionAttempts: Infinity,
    });

    socket.on('connect', () => {
      // Re-joined on every reconnect, not just the first. Room membership does
      // not survive a disconnect, and a dashboard that silently stops
      // receiving telemetry looks identical to a fleet that stopped moving.
      socket.emit('subscribe', { room: DISPATCHER_ROOM });
      useCommandStore.getState().setLink({
        connected: true,
        since: Date.now(),
        error: null,
      });
    });

    socket.on('disconnect', (reason) =>
      useCommandStore.getState().setLink({ connected: false, error: reason }));

    // socket.io retries forever, so without this a backend that is simply not
    // running never reports anything at all -- the indicator would sit on
    // "connecting" indefinitely.
    socket.on('connect_error', (error) =>
      useCommandStore.getState().setLink({ connected: false, error: error.message }));

    socket.on('truck_location_update', (packet) =>
      useCommandStore.getState().ingestTelemetry(packet));

    socket.on('route_updated', (payload) =>
      useCommandStore.getState().ingestRoute(payload));

    socket.on('incident_reported', (payload) =>
      useCommandStore.getState().ingestIncident(payload));

    // Wired, dormant until the backend emits it. See the header note.
    socket.on('burst_sync_complete', (result) =>
      useCommandStore.getState().ingestBurstSync(result));

    // ------------------------------------------------------------ frames
    // One rAF loop for the whole app. It only touches positionStore, whose
    // sole subscriber is the map, so a frame costs one selector evaluation
    // rather than one per mounted panel.
    let frame = requestAnimationFrame(function tick() {
      positionStore.getState().tick(performance.now());
      frame = requestAnimationFrame(tick);
    });

    // Expose the socket for the command adapter (lib/commands.js) so a
    // dispatcher action reuses this connection instead of dialling a second
    // one. Stored on the store rather than a module global so the teardown
    // below genuinely clears it.
    useCommandStore.setState({ socket });
    store.setLink({ connected: false });

    return () => {
      cancelAnimationFrame(frame);
      socket.close();
      useCommandStore.setState({ socket: null });
      useCommandStore.getState().setLink({ connected: false, error: 'closed' });
    };
    // Mount-only. Re-running this would drop and rebuild the socket, losing
    // every packet in flight each time an ancestor re-rendered.
  }, []);
}
