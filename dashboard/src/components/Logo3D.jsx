// The rotating mark at the head of the navigation rail (Three.js, non-map).
//
// Three.js lives here and on the Analytics page. It is kept strictly OFF the
// map: the map is deck.gl over MapLibre, and those two already share the GL
// context budget and a carefully scoped CSS inversion (see index.css). A third
// renderer over the same pixels would fight both.
//
// What it draws: a slowly turning icosahedron inside a canted ring — a lens
// in a gimbal. D.R.I.S.H.T.I. means sight, and an eye in a mount is the one
// figure that reads at 44 px without a label.
//
// Wireframe rather than solid. A solid form needs lights, and lights here
// would have to be tuned against a translucent glass rail whose background is
// a live map — an unwinnable target. Wireframe is self-lit, costs one draw
// call, and matches the console's hairline vocabulary exactly.
import React, { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';

// The phosphor readout colour and the alert red, taken from tokens.css.
// Hardcoded because three.js needs a number, not a CSS variable, and reading
// the computed style per frame to avoid two literals would be worse.
const PHOSPHOR = 0xeaeaea;
const ALERT = 0xf85149;

function Lens({ reduced }) {
  const core = useRef();
  const ring = useRef();
  const halo = useRef();

  useFrame((state, delta) => {
    // Reduced motion still gets the object, just not the spin. Returning a
    // static mark is the honest reading of the preference: the user asked for
    // no animation, not for no logo.
    if (reduced) return;
    // Driven by delta, not by frame count. On a 120 Hz display a per-frame
    // increment spins twice as fast as it does on a 60 Hz one.
    if (core.current) {
      core.current.rotation.y += delta * 0.55;
      core.current.rotation.x += delta * 0.22;
    }
    if (ring.current) ring.current.rotation.z -= delta * 0.35;
    if (halo.current) {
      // A slight breathing scale so the mark never looks frozen even at the
      // moment the icosahedron's symmetry makes rotation hard to read.
      const s = 1 + Math.sin(state.clock.elapsedTime * 1.1) * 0.045;
      halo.current.scale.setScalar(s);
    }
  });

  // Geometry args are constant; memoising keeps R3F from rebuilding the
  // buffers whenever the parent re-renders (which the nav does on every
  // route change).
  const geo = useMemo(() => ({
    core: [1.0, 0],
    ring: [1.62, 0.045, 8, 64],
    halo: [1.95, 0.012, 6, 64],
  }), []);

  return (
    <group>
      <mesh ref={core}>
        <icosahedronGeometry args={geo.core} />
        <meshBasicMaterial color={PHOSPHOR} wireframe />
      </mesh>

      {/* Canted, so the ring reads as a gimbal around the lens rather than a
          flat halo drawn behind it. */}
      <mesh ref={ring} rotation={[Math.PI / 2.6, 0, 0]}>
        <torusGeometry args={geo.ring} />
        <meshBasicMaterial color={PHOSPHOR} transparent opacity={0.55} />
      </mesh>

      {/* The one red element. Section 4 spends red on hazard alone, and this
          is the mark for a hazard console — one thin alert-coloured orbit is
          the whole brand gesture. */}
      <mesh ref={halo} rotation={[Math.PI / 2, 0.5, 0]}>
        <torusGeometry args={geo.halo} />
        <meshBasicMaterial color={ALERT} transparent opacity={0.75} />
      </mesh>
    </group>
  );
}

/**
 * @param size  rendered edge in px. The canvas is square.
 */
export default function Logo3D({ size = 44 }) {
  // Read once at mount rather than subscribed. This is an ornament; a
  // dispatcher who changes the OS setting mid-shift can reload.
  const reduced = useMemo(
    () => typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  return (
    <div style={{ width: size, height: size }} aria-hidden>
      <Canvas
        // Orthographic: a perspective camera on a 44 px canvas spends its
        // depth budget on a mark too small to show any.
        orthographic
        camera={{ position: [0, 0, 8], zoom: 15 }}
        // Capped device pixel ratio. This is a 44 px ornament and a retina
        // display would otherwise render it at 3x for no visible gain, on the
        // same GPU the map is using.
        dpr={[1, 1.5]}
        // The rail is glass; an opaque canvas would punch a hole through it.
        gl={{ alpha: true, antialias: true, powerPreference: 'low-power' }}
        style={{ background: 'transparent' }}
      >
        <Lens reduced={reduced} />
      </Canvas>
    </div>
  );
}
