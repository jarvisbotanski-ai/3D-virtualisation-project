// Portfolio projects shown in "Selected work".
// Adding a project = adding one object here (see README).
//   thumb       image in /public (any aspect, shown 4:3 cover)
//   thumbStyle  optional inline style tweaks for the thumbnail
//   model       optional GLB url — opt-in 3D per project (D21, not wired to a viewer yet)
//   draft       true → shown in the placeholder colour
export const PROJECTS = [
  {
    title: 'Apartment, Vilnius',
    area: 80, year: 2026,
    thumb: '/img/04-textured.png',
    href: '#hero',
  },
  {
    title: '2-room apartment, Vilnius',
    area: 52, year: 2026,
    thumb: '/img/05-migdol.png',
    thumbStyle: 'background-color:#f1efec;background-size:106%',
    model: '/models/migdol_citify.opt.glb',
    href: '#',
  },
];
