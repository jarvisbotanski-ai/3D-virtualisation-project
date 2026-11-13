// Portfolio projects shown in "Work" — one drawing sheet per project.
// Adding a project = adding one object here. Sheet number = position in this list.
//   title        sheet title
//   place, year, area (m²), rooms   → the title block
//   size         optional [width, depth] in metres → dimension line drawn over the view
//   view         main image (any aspect; shown cover-cropped on the sheet)
//   viewStyle    optional inline style for the view (crop/scale tweaks)
//   plan         optional plan drawing (shown contained, never cropped)
//   planPx       plan image size [w, h];  planBox  drawing bbox in % [l, t, r, b]
//                (crop to the outer walls so the dimension lines land on them)
//   note         optional one-line description — leave out rather than invent one
//   model        optional GLB url — opt-in 3D per project (not wired to a viewer yet)
//   href         optional link; no href → the sheet is not a link (no dead clicks)
export const PROJECTS = [
  {
    title: 'Apartment, Vilnius',
    place: 'Vilnius', year: 2026, area: 80,
    size: [5.93, 13.54],
    view: '/img/04-textured.png',
    plan: '/img/01-plan.png',
    planPx: [1600, 1000],                 // image size, for the crop's aspect
    planBox: [5.44, 18.7, 94.63, 81.3],   // drawing bbox in % (l, t, r, b) — measured from the image
  },
  {
    title: '2-room apartment, Vilnius',
    place: 'Vilnius', year: 2026, area: 52,
    view: '/img/05-migdol.png',
    viewStyle: 'background-color:#f7f7f7;background-size:contain',   // image is drawn on #f7f7f7
    model: '/models/migdol_citify.opt.glb',
  },
];
