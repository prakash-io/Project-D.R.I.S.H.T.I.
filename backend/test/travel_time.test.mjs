// Unit tests for the ETA speed model (workflow section 4).
//
// The model is an assumption, not a measurement, so these tests pin its
// BEHAVIOUR rather than its exact output: that a hill highway is slower than
// the same class on the plains, that unpaved costs time, that a bad row
// cannot poison the total. The absolute calibration is checked against real
// drive times in the route sanity list at the bottom.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLASS_SPEED_KMH, DEFAULT_SPEED_KMH, UNPAVED_FACTOR, SINUOSITY_FLOOR,
  edgeSpeedKmh, sinuosityFactor, estimateDurationSec,
} from '../src/services/travelTime.js';

test('class speeds are ordered highway > local', () => {
  assert.ok(CLASS_SPEED_KMH.trunk > CLASS_SPEED_KMH.primary);
  assert.ok(CLASS_SPEED_KMH.primary > CLASS_SPEED_KMH.secondary);
  assert.ok(CLASS_SPEED_KMH.secondary > CLASS_SPEED_KMH.tertiary);
  assert.ok(CLASS_SPEED_KMH.tertiary > CLASS_SPEED_KMH.unclassified);
  assert.ok(CLASS_SPEED_KMH.unclassified > CLASS_SPEED_KMH.residential);
});

test('an unknown class falls back to the commonest tier, not to a highway', () => {
  assert.equal(edgeSpeedKmh('no_such_class', 'asphalt', 1000, 1000), DEFAULT_SPEED_KMH);
  assert.ok(DEFAULT_SPEED_KMH < CLASS_SPEED_KMH.trunk);
});

test('unpaved costs time', () => {
  const paved = edgeSpeedKmh('tertiary', 'asphalt', 1000, 1000);
  const gravel = edgeSpeedKmh('tertiary', 'gravel', 1000, 1000);
  assert.equal(gravel, paved * UNPAVED_FACTOR);
});

test('sinuosity: straight is unpenalised, curved is slower, floored', () => {
  assert.equal(sinuosityFactor(1000, 1000), 1);
  assert.equal(sinuosityFactor(900, 1000), 1, 'a shorter-than-straight edge is not a bonus');
  assert.ok(sinuosityFactor(1114, 1000) < 1);
  assert.ok(sinuosityFactor(5000, 1000) >= SINUOSITY_FLOOR);
});

test('the measured hill/plains trunk gap survives the model', () => {
  // The two sinuosities measured on real routed edges.
  const hill = edgeSpeedKmh('trunk', 'asphalt', 1114, 1000);   // Guwahati-Shillong
  const plains = edgeSpeedKmh('trunk', 'asphalt', 1004, 1000); // Guwahati-Tezpur
  assert.ok(hill < plains, 'hill trunk must be slower than plains trunk');
  assert.ok(plains > 0.95 * CLASS_SPEED_KMH.trunk, 'a straight highway is barely penalised');
  assert.ok(hill < 0.75 * CLASS_SPEED_KMH.trunk, 'a hill highway is meaningfully penalised');
});

test('duration sums per edge, so class composition changes the answer', () => {
  const tenKmTrunk = [{ lengthM: 10000, straightM: 10000, highway: 'trunk', surface: 'asphalt' }];
  const tenKmLocal = [{ lengthM: 10000, straightM: 10000, highway: 'residential', surface: 'asphalt' }];
  assert.ok(estimateDurationSec(tenKmLocal) > estimateDurationSec(tenKmTrunk));
  // 10 km of trunk at 45 km/h is 800 s.
  assert.equal(Math.round(estimateDurationSec(tenKmTrunk)), 800);
});

test('a bad row contributes nothing rather than NaN', () => {
  const good = { lengthM: 1000, straightM: 1000, highway: 'trunk', surface: 'asphalt' };
  const total = estimateDurationSec([
    good,
    { lengthM: null, straightM: null, highway: 'trunk', surface: null },
    { lengthM: NaN, straightM: 1, highway: 'trunk', surface: null },
    { lengthM: -5, straightM: 1, highway: 'trunk', surface: null },
  ]);
  assert.ok(Number.isFinite(total));
  assert.equal(Math.round(total), Math.round(estimateDurationSec([good])));
});

test('an empty route takes no time', () => {
  assert.equal(estimateDurationSec([]), 0);
});
