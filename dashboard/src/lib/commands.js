// Dispatcher -> driver commands (Task 4).
//
// -------------------------------------------------------------------------
// READ THIS BEFORE CHANGING ANYTHING HERE
// -------------------------------------------------------------------------
// Socket.IO clients cannot talk to each other. Every message from this
// dashboard to a driver's phone has to be relayed by a handler on the server,
// and the server currently registers exactly two inbound handlers:
//
//     socket.on('subscribe', ...)               // join a room
//     socket.on('truck_location_update', ...)   // a truck reporting its own fix
//
// (backend/src/sockets/telemetry.js). There is no relay for a dispatcher-
// originated message. So an emitted `driver_alert` reaches the server and is
// dropped on the floor -- not an error, just nothing listening.
//
// This task is not permitted to modify the backend, so rather than pretend,
// every function here reports what actually happened:
//
//     delivered: true   the driver's phone has it, confirmed
//     delivered: false  the command was correct and went nowhere
//
// and the UI renders that distinction. A dispatcher who believes they warned a
// driver who was never warned is the worst outcome this screen can produce --
// considerably worse than a button that admits it is not connected yet.
//
// WHAT DOES WORK TODAY, with no backend change: approving an incident. That
// path is entirely server-side once the POST lands --
// `rerouteAffectedTrips()` recomputes every affected trip and emits
// `route_updated` into `truck:<id>`, which is the room the driver's app joined
// in mobile-app/src/services/socket.js, and the phone then speaks the reroute
// through Bhashini. So `emergencyReroute` prefers that path whenever the
// hazard has a reviewable incident behind it, and only falls back to the
// direct push for a hazard with no incident record.
//
// The relay that would close the gap is small and belongs in
// backend/src/sockets/telemetry.js, inside the existing io.on('connection'):
//
//     socket.on('dispatcher_command', ({ room, event, payload }, ack) => {
//       if (typeof room !== 'string' || !room.startsWith('truck:')) {
//         return ack?.({ ok: false, error: 'bad room' });
//       }
//       io.to(room).emit(event, payload);
//       ack?.({ ok: true, room, event });
//     });
//
// and the phone would need `socket.on('driver_alert', ...)` alongside its
// existing `route_updated` listener. Both are noted in the handover; neither
// is written here.

import { API_URL } from './api';
import { useCommandStore } from '../store/commandStore';
import { planEmergencyReroute } from './googleRoutes';

/// How long to wait for the server to acknowledge a relayed command before
/// calling it undelivered. The relay acks synchronously when it exists, so
/// anything past two seconds means no handler is listening.
const ACK_TIMEOUT_MS = 2000;

/**
 * Emit a command into a truck's room and wait for the server to confirm.
 *
 * Resolves `{ delivered, reason }`. Never rejects: a command that cannot be
 * delivered is a fact to display, not an exception to swallow somewhere up the
 * stack.
 */
function relay(truckId, event, payload) {
  const socket = useCommandStore.getState().socket;
  if (!socket?.connected) {
    return Promise.resolve({ delivered: false, reason: 'No connection to the telemetry backend' });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => finish({
      delivered: false,
      reason: 'No relay handler on the backend — command not delivered to the driver',
    }), ACK_TIMEOUT_MS);

    socket.emit('dispatcher_command', { room: `truck:${truckId}`, event, payload }, (ack) => {
      clearTimeout(timer);
      finish(ack?.ok
        ? { delivered: true, reason: null }
        : { delivered: false, reason: ack?.error ?? 'Backend rejected the command' });
    });
  });
}

/**
 * WARN DRIVER -- a targeted spoken alert on the driver's handset.
 *
 * The payload deliberately mirrors what the phone's voice path already
 * consumes: `language` picks the Bhashini target (the truck's `alert_lang`
 * column holds 'as' | 'hi' | 'en'), and `text` is what gets translated and
 * spoken. Matching the existing shape means the phone needs a listener, not a
 * new code path.
 */
export async function warnDriver({ truckId, text, language = 'en', severity = 'warning' }) {
  const message = (text ?? '').trim();
  if (!truckId) return { delivered: false, reason: 'No truck selected' };
  if (!message) return { delivered: false, reason: 'Message is empty' };

  const result = await relay(truckId, 'driver_alert', {
    truck_id: truckId,
    severity,
    language,
    text: message,
    issued_at: new Date().toISOString(),
    issued_by: 'dispatcher',
  });

  useCommandStore.getState().pushAlert({
    tone: result.delivered ? 'info' : 'warn',
    title: result.delivered ? 'Driver warned' : 'Warning NOT delivered',
    body: result.delivered
      ? `${truckId.slice(0, 8)} — "${message}"`
      : result.reason,
    truckId,
  });
  return result;
}

/**
 * EMERGENCY REROUTE.
 *
 * Two mechanisms, and the return value says which one ran:
 *
 *   'approve'  the hazard has an incident awaiting review, so approving it
 *              closes the edge and the backend reroutes every affected trip
 *              and pushes each new route into its truck's room. Fully
 *              delivered, no relay needed. This is the real path.
 *
 *   'push'     no incident to approve, so a route is computed here and pushed
 *              directly -- which needs the relay that does not exist yet.
 *
 * The computed geometry is stored either way, so the dispatcher sees the
 * proposed road on the map even when it could not be sent.
 */
export async function emergencyReroute({ truck, hazard, destination }) {
  const store = useCommandStore.getState();
  if (!truck) return { ok: false, reason: 'No truck selected' };

  const from = { lat: truck.lat, lng: truck.lng };
  const to = destination ?? inferDestination(truck);
  if (!to) {
    return {
      ok: false,
      reason: 'No destination known for this truck — start a trip before rerouting',
    };
  }

  // Compute first, so there is something to show whichever path delivers.
  const plan = await planEmergencyReroute({
    from,
    to,
    hazard: hazard ? { lat: hazard.lat, lng: hazard.lng } : null,
  });

  if (plan.feature) {
    store.ingestRoute({
      truck_id: truck.truck_id,
      geometry: plan.feature.geometry,
      distance_m: plan.feature.properties?.distance_m ?? null,
      provider: plan.provider,
      incident_id: hazard?.id ?? null,
    });
  }

  // --- path 1: approve the incident, and let the backend do the rest -------
  const pendingId = hazard?.id
    && (hazard.status === 'pending' || hazard.status === 'pending_dispatcher_approval')
    ? hazard.id
    : null;

  if (pendingId) {
    try {
      const response = await fetch(`${API_URL}/incidents/${pendingId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved_by: 'dispatcher' }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);

      const rerouted = (body.reroutes ?? []).filter((r) => r.rerouted).length;
      store.pushAlert({
        tone: 'critical',
        title: 'Emergency reroute issued',
        body: `Edge ${body.incident?.blocked_edge ?? '—'} blocked · ${rerouted} truck(s) rerouted and notified`,
        truckId: truck.truck_id,
        sticky: true,
      });
      return { ok: true, mechanism: 'approve', delivered: true, reroutes: body.reroutes ?? [], plan };
    } catch (error) {
      store.pushAlert({
        tone: 'warn',
        title: 'Reroute not issued',
        body: error.message,
        truckId: truck.truck_id,
      });
      return { ok: false, mechanism: 'approve', delivered: false, reason: error.message, plan };
    }
  }

  // --- path 2: push the computed route directly ----------------------------
  if (!plan.feature) {
    store.pushAlert({ tone: 'warn', title: 'Reroute failed', body: plan.note, truckId: truck.truck_id });
    return { ok: false, mechanism: 'push', delivered: false, reason: plan.note, plan };
  }

  const result = await relay(truck.truck_id, 'route_updated', {
    truck_id: truck.truck_id,
    incident_id: hazard?.id ?? null,
    distance_m: plan.feature.properties?.distance_m ?? null,
    geometry: plan.feature.geometry,
    provider: plan.provider,
  });

  store.pushAlert({
    tone: result.delivered ? 'critical' : 'warn',
    title: result.delivered ? 'Emergency reroute pushed' : 'Reroute computed but NOT delivered',
    body: result.delivered ? plan.note : result.reason,
    truckId: truck.truck_id,
    sticky: result.delivered,
  });
  return { ok: result.delivered, mechanism: 'push', delivered: result.delivered, plan, reason: result.reason };
}

/**
 * Where is this truck going?
 *
 * There is no endpoint that serves a truck's active trip destination to the
 * dashboard -- GET /trucks returns position and identity only. So the
 * destination is taken from the last route the backend pushed for this truck,
 * whose final coordinate IS the trip destination (rerouteAffectedTrips routes
 * to `trip.dest_lat/dest_lng`). Returns null when this truck has never been
 * routed, and the caller says so rather than guessing a destination.
 */
function inferDestination(truck) {
  const route = useCommandStore.getState().routes[truck.truck_id];
  const coordinates = route?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const [lng, lat] = coordinates[coordinates.length - 1];
  return { lat, lng };
}
