/** Colours of the faces, from the worst (1) to the best. */
const COLOURS: Record<3 | 5, string[]> = {
  3: ['#dc2626', '#d97706', '#16a34a'],
  5: ['#dc2626', '#ea580c', '#d97706', '#65a30d', '#16a34a'],
};

/** Emoji for e-mails and plain text, where an image may not load. */
export const EMOJI: Record<3 | 5, string[]> = {
  3: ['😞', '😐', '😊'],
  5: ['😠', '😞', '😐', '🙂', '😄'],
};

/** Mouth curvature from sad (-1) to happy (1). */
const curve = (score: number, faces: 3 | 5) => -1 + (2 * (score - 1)) / (faces - 1);

/** A face for a score (1 … faces), drawn as SVG so it looks the same everywhere. */
export function Face({
  score,
  faces,
  size = 56,
  filled = true,
}: {
  score: number;
  faces: 3 | 5;
  size?: number;
  /** Outline only (for paper, where the face is printed in black). */
  filled?: boolean;
}) {
  const c = COLOURS[faces][score - 1]!;
  const k = curve(score, faces);
  // Mouth from (14,32) to (34,32), bent up or down by k.
  const mouthY = 32 + (k < 0 ? 2 : -1);
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className="shrink-0"
      data-face={score}
    >
      <circle
        cx="24"
        cy="24"
        r="21"
        fill={filled ? c : 'none'}
        stroke={filled ? c : 'currentColor'}
        strokeWidth="2.5"
      />
      <circle cx="17" cy="19" r="2.6" fill={filled ? '#fff' : 'currentColor'} />
      <circle cx="31" cy="19" r="2.6" fill={filled ? '#fff' : 'currentColor'} />
      <path
        d={`M 14 ${mouthY} Q 24 ${mouthY + 9 * k} 34 ${mouthY}`}
        fill="none"
        stroke={filled ? '#fff' : 'currentColor'}
        strokeWidth="2.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
