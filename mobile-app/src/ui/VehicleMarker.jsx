// The truck on the map: a heading-locked chevron, exactly where the fix is.
//
// A plain dot cannot say which way the vehicle is pointing, and on a hairpin
// climb that is the single most useful thing on the screen -- it is what tells
// the driver whether the blue line ahead is the road they are on or the one
// they just left. Every navigator draws a directional puck for this reason.
//
// Drawn as a MarkerView (a real React view pinned to a coordinate) rather than
// a SymbolLayer, because a SymbolLayer icon needs a raster image registered
// with the style, and a vector-icon glyph rotated in JS needs no asset, no
// pipeline and no second source of truth for the brand colour.
//
// It is deliberately drawn OVER the CircleLayer halo in MapCanvas rather than
// replacing it. The halo is pure GL and always paints; the marker is a native
// view and is the part that could fail on an unusual device. Losing the icon
// on such a handset costs the heading and leaves the truck perfectly visible,
// which is the right way round for the one element a driver navigates by.
import React from 'react';
import { View, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import * as MapLibreRN from '@maplibre/maplibre-react-native';
import { t } from './tokens';

/**
 * @param fix      { latitude, longitude, heading?, source? }
 * @param heading  degrees, 0-360; falls back to the fix's own heading
 */
/**
 * Pure-GL stand-in for the puck: a solid, hard-edged dot in the same colour.
 *
 * Drawn by MapLibre's own renderer, with no React Native view and no bridge
 * crossing, so it paints on any device that can draw the map at all. This is
 * what the boundary in MapCanvas falls back to when MarkerView does not mount.
 *
 * It is NOT the accuracy halo. The halo is deliberately faint (0.22 alpha,
 * blurred) because it sits *behind* a solid puck; on its own it reads as a
 * smudge rather than a vehicle. Losing the puck should cost the driver the
 * heading, not the truck.
 */
export function VehicleMarkerFallback({ fix }) {
  if (!fix || !Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude)) {
    return null;
  }
  const tone = fix.source === 'ekf'
    ? t.color.sourceDeadReckoning
    : t.color.sourceGnss;

  return (
    <MapLibreRN.ShapeSource
      id="truck-fallback"
      shape={{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [fix.longitude, fix.latitude] },
      }}
    >
      <MapLibreRN.CircleLayer
        id="truck-fallback-dot"
        style={{
          circleRadius: 9,
          circleColor: tone,
          circleStrokeWidth: 3,
          circleStrokeColor: '#FFFFFF',
        }}
      />
    </MapLibreRN.ShapeSource>
  );
}

export default function VehicleMarker({ fix, heading }) {
  if (!fix || !Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude)) {
    return null;
  }

  // The bridge may simply not be there. A MapLibre version bump that renames
  // or drops MarkerView would otherwise surface as
  // `React.createElement: type is invalid` at render, which is a boundary
  // catch and a red card on the driver's map; checking for it turns that into
  // the fallback dot, silently and correctly. Cheap, and the only way this
  // component can know the native side disagrees with it.
  if (!MapLibreRN.MarkerView) {
    console.warn('[marker] MapLibreRN.MarkerView unavailable — '
      + 'falling back to a plain dot; the driver loses heading, not the truck');
    return <VehicleMarkerFallback fix={fix} />;
  }

  // GNSS blue / dead-reckoning amber -- the same two colours the dispatcher's
  // map uses for the same two things. A driver and a dispatcher discussing one
  // truck must not be looking at different colours for the same fix.
  const dead = fix.source === 'ekf';
  const tone = dead ? t.color.sourceDeadReckoning : t.color.sourceGnss;

  const bearing = Number.isFinite(heading) ? heading
    : (Number.isFinite(fix.heading) ? fix.heading : null);

  return (
    <MapLibreRN.MarkerView
      coordinate={[fix.longitude, fix.latitude]}
      anchor={{ x: 0.5, y: 0.5 }}
      // Never hidden behind a hazard label or another marker. The truck is the
      // one thing on this map that must always be visible.
      allowOverlap
    >
      <View style={styles.hit} pointerEvents="none">
        <View style={[styles.puck, { backgroundColor: tone }]}>
          <Icon
            // A chevron when the heading is known, a dot when it is not.
            // Drawing the chevron pointing north on a fix with no heading
            // would state a direction nothing measured.
            name={bearing === null ? 'circle' : 'navigation'}
            size={bearing === null ? 10 : 18}
            color="#FFFFFF"
            style={bearing === null
              ? null
              // MaterialIcons' `navigation` glyph points up, which is map
              // north at bearing 0 -- so the rotation is the bearing itself,
              // with no offset to get wrong.
              : { transform: [{ rotate: `${bearing}deg` }] }}
            importantForAccessibility="no"
          />
        </View>
      </View>
    </MapLibreRN.MarkerView>
  );
}

const styles = StyleSheet.create({
  // A fixed box around the puck. MarkerView anchors to the centre of its
  // child, so a view that resizes with its content would drift off the fix as
  // the icon swaps between the chevron and the dot.
  hit: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  puck: {
    width: 30, height: 30, borderRadius: 15,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 3, borderColor: '#FFFFFF',
    // Lifts the puck off a dark raster tile at night, where a white ring on
    // its own can vanish into the terrain.
    ...t.shadow.control,
  },
});
