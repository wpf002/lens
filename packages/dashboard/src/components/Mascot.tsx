/**
 * Iris, the Lens mascot: a 16x16 pixel owl wearing a brass monocle.
 * Rendered as SVG rects so it stays crisp at any size and needs no assets.
 */

const PX: Record<string, string> = {
  D: "#6e3a16", // tufts / outline
  B: "#c06a2b", // body
  L: "#f0c27a", // belly
  W: "#fff4dc", // eye white
  K: "#1a1208", // pupil
  Y: "#f59e0b", // beak
  M: "#e9b85a", // monocle ring + chain
  F: "#e0892c", // feet
};

// prettier-ignore
const ART = [
  "..D..........D..",
  "..DD........DD..",
  "..DBBBBBBBBBBD..",
  ".DBBBBBBBBBBBBD.",
  ".BBBBBBBBMMMMMM.",
  ".BWWWWBBBMWWWWM.",
  ".BWKKWBBBMWKKWM.",
  ".BWKKWBBBMWKKWM.",
  ".BWWWWBYYMWWWWM.",
  ".BBBBBBYBMMMMMM.",
  ".BBLLLLLLLLLLBM.",
  ".BLLDLLDLLDLLBBM",
  ".BBLLDLLDLLDLBB.",
  "..BBLLLLLLLLBB..",
  "...BBBBBBBBBB...",
  "....FF....FF....",
];

const RECTS = ART.flatMap((row, y) =>
  [...row].flatMap((c, x) => (PX[c] ? [{ x, y, fill: PX[c] }] : [])),
);

/** The owl as an SVG group in a 16x16 unit box, for embedding in larger drawings. */
export function OwlPixels({ blink = true }: { blink?: boolean }) {
  return (
    <g shapeRendering="crispEdges">
      {RECTS.map((r) => (
        <rect key={`${r.x}:${r.y}`} x={r.x} y={r.y} width={1.02} height={1.02} fill={r.fill} />
      ))}
      {/* Monocle glint */}
      <rect className="lens-twinkle" x={13} y={5} width={1} height={1} fill="#ffffff" />
      {blink && (
        <g className="lens-blink" fill={PX.B}>
          <rect x={2} y={5} width={4} height={4} />
          <rect x={10} y={5} width={4} height={4} />
        </g>
      )}
    </g>
  );
}

export function Mascot({ size = 64, className, title = "Iris, the Lens owl" }: { size?: number; className?: string; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} role="img" aria-label={title}>
      <OwlPixels />
    </svg>
  );
}
