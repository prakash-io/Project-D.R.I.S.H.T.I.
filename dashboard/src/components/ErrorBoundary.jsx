// A boundary that keeps one broken compartment from taking the console down.
//
// The dispatcher console is a single React tree containing a WebGL map, two
// WebGL decorations and several live data panels. React unmounts the WHOLE
// tree when any component throws during render, so without a boundary a lost
// WebGL context in the navbar logo -- an ornament -- blanks the map, the
// incident queue and the telemetry readout with it.
//
// Deliberately not one boundary at the root. A root-level boundary would
// catch the throw and still replace everything with a fallback, which is the
// same outcome. The boundaries that matter are the tight ones, around the
// parts that can fail independently of the parts a dispatcher is working in.
import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Logged, never swallowed. A decoration that silently stops appearing is
    // how a real regression hides for weeks.
    console.error(`[boundary:${this.props.label ?? 'unnamed'}]`,
      error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    // `fallback === null` is a legitimate choice for an ornament: an empty
    // slot is better than an error card where a spinning logo used to be.
    if (this.props.fallback !== undefined) return this.props.fallback;

    return (
      <div
        role="status"
        className="border border-danger/50 bg-panel/90 px-3 py-2"
      >
        <p className="meta text-danger-text">
          {this.props.label ?? 'Component'} unavailable
        </p>
        <p className="mt-1 font-mono text-[10px] text-muted">
          {this.state.error.message}
        </p>
      </div>
    );
  }
}
