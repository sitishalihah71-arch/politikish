// Stickman rendering: hair/face are config-driven so new styles are just new
// array entries, never a code change. Pure functions, no DOM - safe to use
// from both ui.js (rendering) and room.js (validating incoming updates).

const INK = '#1a1a1a';
const SKIN = '#f4ede1';

export const HAIR_STYLES = [
  { id: 'bald', name: 'Bald', svg: '' },
  {
    id: 'spiky',
    name: 'Spiky',
    svg: `<polyline points="24,32 30,8 36,28 44,4 52,26 60,2 68,26 76,4 84,28 90,8 96,32" fill="none" stroke="${INK}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`,
  },
  {
    id: 'curly',
    name: 'Curly',
    svg: `<g fill="none" stroke="${INK}" stroke-width="4">
      <circle cx="30" cy="26" r="10"/>
      <circle cx="46" cy="15" r="11"/>
      <circle cx="62" cy="11" r="11"/>
      <circle cx="78" cy="15" r="11"/>
      <circle cx="92" cy="26" r="10"/>
    </g>`,
  },
  {
    id: 'ponytail',
    name: 'Ponytail',
    svg: `<path d="M 24 34 Q 30 8 60 8 Q 90 8 96 34" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>
      <path d="M 91 20 Q 112 24 108 48 Q 106 62 95 59" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>`,
  },
  {
    id: 'mohawk',
    name: 'Mohawk',
    svg: `<path d="M 50 6 L 54 30 M 60 1 L 62 30 M 70 6 L 66 30" stroke="${INK}" stroke-width="4" stroke-linecap="round" fill="none"/>`,
  },
  {
    id: 'bob',
    name: 'Bob',
    svg: `<path d="M 22 36 Q 17 -3 60 -3 Q 103 -3 98 36 L 98 60 Q 90 50 90 34 L 30 34 Q 30 50 22 60 Z" fill="none" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>`,
  },
];

export const FACE_STYLES = [
  {
    id: 'happy',
    name: 'Happy',
    svg: `<circle cx="46" cy="50" r="4" fill="${INK}"/><circle cx="74" cy="50" r="4" fill="${INK}"/>
      <path d="M 46 66 Q 60 78 74 66" stroke="${INK}" stroke-width="4" fill="none" stroke-linecap="round"/>`,
  },
  {
    id: 'neutral',
    name: 'Neutral',
    svg: `<circle cx="46" cy="50" r="4" fill="${INK}"/><circle cx="74" cy="50" r="4" fill="${INK}"/>
      <line x1="48" y1="70" x2="72" y2="70" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>`,
  },
  {
    id: 'surprised',
    name: 'Surprised',
    svg: `<circle cx="46" cy="50" r="6" fill="none" stroke="${INK}" stroke-width="3"/><circle cx="74" cy="50" r="6" fill="none" stroke="${INK}" stroke-width="3"/>
      <circle cx="60" cy="72" r="6" fill="none" stroke="${INK}" stroke-width="3"/>`,
  },
  {
    id: 'wink',
    name: 'Wink',
    svg: `<circle cx="46" cy="50" r="4" fill="${INK}"/><path d="M 68 50 L 80 50" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>
      <path d="M 46 66 Q 60 76 74 66" stroke="${INK}" stroke-width="4" fill="none" stroke-linecap="round"/>`,
  },
  {
    id: 'sleepy',
    name: 'Sleepy',
    svg: `<path d="M 40 50 Q 46 54 52 50" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M 68 50 Q 74 54 80 50" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round"/>
      <line x1="52" y1="70" x2="68" y2="70" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`,
  },
  {
    id: 'angry',
    name: 'Angry',
    svg: `<path d="M 38 40 L 52 45" stroke="${INK}" stroke-width="3" stroke-linecap="round"/><path d="M 82 40 L 68 45" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>
      <circle cx="46" cy="52" r="4" fill="${INK}"/><circle cx="74" cy="52" r="4" fill="${INK}"/>
      <path d="M 48 74 Q 60 64 72 74" stroke="${INK}" stroke-width="4" fill="none" stroke-linecap="round"/>`,
  },
];

export function normalizeAvatar(avatar) {
  const hairCount = HAIR_STYLES.length;
  const faceCount = FACE_STYLES.length;
  const hair = Number.isInteger(avatar?.hair) ? avatar.hair : 0;
  const face = Number.isInteger(avatar?.face) ? avatar.face : 0;
  return {
    hair: Math.min(Math.max(hair, 0), hairCount - 1),
    face: Math.min(Math.max(face, 0), faceCount - 1),
  };
}

// Backdrop is baked into the SVG (rather than relying on the container's
// CSS) so contrast holds wherever this gets reused later - lobby rows, seat
// portraits, etc. - regardless of that surface's background color.
export function renderAvatarSVG(avatar, size = 96) {
  const { hair, face } = normalizeAvatar(avatar);
  const hairSvg = HAIR_STYLES[hair].svg;
  const faceSvg = FACE_STYLES[face].svg;
  const height = Math.round(size * (160 / 120));
  return `<svg viewBox="0 -20 120 160" width="${size}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="-20" width="120" height="160" rx="14" fill="${SKIN}"/>
    <path d="M 20 140 Q 20 95 60 95 Q 100 95 100 140 Z" fill="${SKIN}" stroke="${INK}" stroke-width="4"/>
    <circle cx="60" cy="55" r="38" fill="${SKIN}" stroke="${INK}" stroke-width="4"/>
    ${hairSvg}
    ${faceSvg}
  </svg>`;
}
