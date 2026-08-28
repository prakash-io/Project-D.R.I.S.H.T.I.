// Keeps one failing component from taking the driver's whole screen with it.
//
// This app has never been built or rendered on a handset. Everything in
// src/ui/ is verified by parse and by import resolution only, so the first
// APK is the first time any of it meets a real Android view system. The
// components most likely to fail there are the ones backed by NATIVE views --
// MapLibre's MapView and MarkerView -- because those are the ones whose
// behaviour is not decided by this codebase at all.
//
// React unmounts the ENTIRE tree when any component throws during render.
// Without a boundary, a MarkerView that fails to bridge on some OEM's Android
// build takes down the map, the speed readout, the hazard button and the sync
// queue with it, and the driver is left with a blank screen in a valley with
// no signal. That is the failure this file exists to prevent.
//
// Deliberately NOT one boundary at the root. A root boundary catches the throw
// and still replaces everything with a fallback, which is the same outcome
// dressed up. The boundaries that matter are tight ones around the parts that
// can fail independently of the parts the driver is navigating by.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { t } from './tokens';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Logged loudly and never swallowed. A component that silently stops
    // appearing on one device model is how a real defect survives a whole
    // field trial, and this is the one build where that matters most.
    console.error(
      `[boundary:${this.props.label ?? 'unnamed'}]`,
      error?.message ?? error,
      info?.componentStack,
    );
    this.props.onError?.(error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    // `fallback` may legitimately be null -- for an ornament, an empty slot
    // beats an error card. It may also be a pure-GL substitute, which is what
    // the vehicle marker uses.
    if (this.props.fallback !== undefined) return this.props.fallback;

    return (
      <View style={styles.card} accessibilityRole="alert">
        <Text style={styles.title}>
          {this.props.label ?? 'This panel'} could not be drawn
        </Text>
        <Text style={styles.detail} numberOfLines={3}>
          {String(this.state.error?.message ?? this.state.error)}
        </Text>
        {/* Says what still works. A driver in a dark zone needs to know
            whether tracking is still running, and a bare error message does
            not answer that -- the queue and the engine are untouched by a
            view failing to mount. */}
        <Text style={styles.detail}>
          Tracking and the offline queue are unaffected.
        </Text>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  card: {
    padding: t.space.md,
    backgroundColor: t.color.alertWash,
    borderRadius: t.radius.inner,
    borderWidth: t.hairline,
    borderColor: t.color.alertFill,
  },
  title: {
    fontFamily: t.font.sansMedium,
    fontSize: t.type.body,
    color: t.color.alertText,
  },
  detail: {
    fontFamily: t.font.sans,
    fontSize: t.type.micro,
    color: t.color.textSecondary,
    marginTop: 4,
  },
});
