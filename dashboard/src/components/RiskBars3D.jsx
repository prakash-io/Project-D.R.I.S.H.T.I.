// Interactive 3D risk chart for the Analytics page (Three.js, non-map).
//
// Three.js is confined to the dashboard's own chrome -- this component and the
// navigation mark. It is deliberately NOT used for anything geographic: the
// map is deck.gl over MapLibre, and putting a second renderer over the same
// coordinates would duplicate the projection, the picking and the CSS
// inversion scoping that index.css spends a long comment getting right.
//
// Why a 3D chart is defensible here, when a 2D bar chart reads more precisely:
// this view answers "where is risk concentrated across the network", which is
// two categorical axes (corridor x segment rank) against one measure. Laid
// flat that is a heatmap whose cells are too small to label; on a turntable
// the same data keeps its rows readable because the near row occludes nothing
// behind it. Precision is preserved by the HTML readout beside it -- the
// canvas ranks, the table states values.
import React, { useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';

const PHOSPHOR = '#eaeaea';
const ALERT = '#f85149';
const AMBER = '#d29922';
const EDGE = '#3d3d3d';

/// Amber at the flag threshold through red at 1.0 — the same ramp MapView
/// uses for risk corridors, so a bar and the road it stands for are never
/// two different colours for one number.
function riskTone(score, threshold) {
  const t = Math.max(0, Math.min(1, (score - threshold) / Math.max(0.0001, 1 - threshold)));
  return t > 0.5 ? ALERT : AMBER;
}

function Bar({ x, height, tone, id, label, value, onHover, hovered }) {
  const mesh = useRef();

  useFrame((_, delta) => {
    if (!mesh.current) return;
    // Grow into place on mount and lift on hover, both eased rather than
    // snapped. The lift is what makes the chart feel like an instrument
    // instead of a screenshot.
    const target = hovered ? height * 1.08 : height;
    const current = mesh.current.scale.y;
    mesh.current.scale.y += (target - current) * Math.min(1, delta * 8);
    mesh.current.position.y = mesh.current.scale.y / 2;
  });

  return (
    <mesh
      ref={mesh}
      position={[x, 0, 0]}
      scale={[0.42, 0.001, 0.42]}
      onPointerOver={(e) => { e.stopPropagation(); onHover({ id, label, value }); }}
      onPointerOut={(e) => { e.stopPropagation(); onHover(null); }}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial
        color={tone}
        emissive={tone}
        // The hovered bar emits harder rather than changing hue: hue is
        // already spent encoding the score, so hover has to use a channel
        // that is not carrying data.
        emissiveIntensity={hovered ? 0.85 : 0.28}
        roughness={0.45}
        metalness={0.1}
      />
    </mesh>
  );
}

function Scene({ items, threshold, onHover, hoveredId }) {
  const group = useRef();

  useFrame((state, delta) => {
    if (!group.current) return;
    // A slow turntable, paused while the pointer is on a bar so a reader can
    // actually hold one still and compare it.
    if (hoveredId === null) group.current.rotation.y += delta * 0.16;
    // A gentle tilt driven by pointer Y, so the chart tracks the reader.
    const target = -0.22 + state.pointer.y * 0.12;
    group.current.rotation.x += (target - group.current.rotation.x) * Math.min(1, delta * 3);
  });

  const max = Math.max(...items.map((i) => i.value), 0.0001);
  const span = 5.4;
  const step = items.length > 1 ? span / (items.length - 1) : 0;

  return (
    <>
      <ambientLight intensity={0.55} />
      <directionalLight position={[4, 8, 6]} intensity={1.15} />
      <directionalLight position={[-6, 3, -4]} intensity={0.35} color={PHOSPHOR} />

      <group ref={group} rotation={[-0.22, 0, 0]}>
        {items.map((item, i) => (
          <Bar
            // Keyed by edge id, never by name: the extract has hundreds of
            // edges sharing one road name, and keying on the label both
            // collided in React and made a hover highlight every segment of
            // the same highway at once.
            key={item.id}
            id={item.id}
            x={-span / 2 + i * step}
            // Normalised to the tallest bar rather than to 1.0. These scores
            // cluster tightly above the threshold, and an absolute scale would
            // render ten bars of visually identical height.
            height={0.35 + (item.value / max) * 2.6}
            tone={riskTone(item.score ?? item.value, threshold)}
            label={item.label}
            value={item.value}
            hovered={hoveredId === item.id}
            onHover={onHover}
          />
        ))}

        {/* Ground plane, as a wireframe rather than a solid: a solid floor
            under a translucent panel reads as a second background. */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
          <planeGeometry args={[7.4, 2.6, 12, 4]} />
          <meshBasicMaterial color={EDGE} wireframe transparent opacity={0.35} />
        </mesh>
      </group>
    </>
  );
}

/**
 * @param items      [{ label, value, score? }] — `value` drives height,
 *                   `score` drives colour when the two differ
 * @param threshold  the flag level, for the colour ramp's floor
 */
export default function RiskBars3D({ items, threshold = 0.85, height = 300 }) {
  const [hovered, setHovered] = useState(null);

  // Identity-stable so the Scene's map does not rebuild every render.
  const data = useMemo(() => items.slice(0, 14), [items]);

  if (data.length === 0) {
    return (
      <div
        style={{ height }}
        className="grid place-items-center border border-edge bg-panel/50"
      >
        <p className="meta">No scored segments to plot</p>
      </div>
    );
  }

  return (
    <div className="relative" style={{ height }}>
      <Canvas
        camera={{ position: [0, 2.6, 7.2], fov: 42 }}
        dpr={[1, 1.75]}
        gl={{ alpha: true, antialias: true }}
        style={{ background: 'transparent' }}
      >
        <Scene
          items={data}
          threshold={threshold}
          onHover={(h) => setHovered(h)}
          hoveredId={hovered?.id ?? null}
        />
      </Canvas>

      {/* The precise readout. The canvas ranks; this states the value, so
          nothing depends on judging a bar height by eye. */}
      <div
        role="status"
        className="pointer-events-none absolute bottom-2 left-2 border border-edge
                   bg-panel/90 px-3 py-2 backdrop-blur"
      >
        {hovered ? (
          <>
            <div className="font-mono text-[11px] text-phosphor">{hovered.label}</div>
            <div className="meta mt-0.5">
              {(hovered.value * 100).toFixed(1)}%
            </div>
          </>
        ) : (
          <div className="meta">Hover a bar · {data.length} segments</div>
        )}
      </div>
    </div>
  );
}
