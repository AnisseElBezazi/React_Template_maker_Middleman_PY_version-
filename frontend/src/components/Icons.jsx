// Marque et icones de l'interface. Transcription byte-fidele de
// icons_view.mjs (Node) -- ne pas redessiner un trace de memoire, copier
// depuis la source si une icone est ajoutee ou change.

export const Logo = () => (
  <svg className="logo" width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <rect x="1" y="1" width="10.5" height="10.5" rx="2" fill="#b0b0b0" />
    <rect x="6.25" y="6.25" width="10.75" height="10.75" rx="2.25" stroke="#0d99ff" strokeWidth="1.5" fill="none" />
  </svg>
);

const svg = (children) => (props) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>{children}</svg>
);

export const IconBack = svg(<path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />);
export const IconFile = svg(<><path d="M9 1.75H4.25a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V5.5L9 1.75Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M8.75 2v3.25H12" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></>);
export const IconPlay = svg(<path d="M5 3.4v9.2a.5.5 0 0 0 .77.42l7-4.6a.5.5 0 0 0 0-.84l-7-4.6A.5.5 0 0 0 5 3.4Z" fill="currentColor" />);
export const IconCursor = svg(<path d="M3.2 2.4 12.6 7l-4 1.6L7 12.6 3.2 2.4Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />);
export const IconClose = svg(<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />);
export const IconDownload = svg(<path d="M8 2.5v7.5m0 0L5.25 7.25M8 10l2.75-2.75M3 12.25h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />);
export const IconLayers = svg(<><path d="M8 1.75 1.75 5 8 8.25 14.25 5 8 1.75Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="m1.75 8.75 6.25 3.25 6.25-3.25" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></>);
export const IconThink = svg(<><circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.3" /><circle cx="5.2" cy="8" r="1" fill="currentColor" /><circle cx="8" cy="8" r="1" fill="currentColor" /><circle cx="10.8" cy="8" r="1" fill="currentColor" /></>);
export const IconWrite = svg(<path d="M10.4 2.6 13.4 5.6 5.9 13.1l-3.4.4.4-3.4 7.5-7.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />);
export const IconWarn = svg(<><path d="M8 2.25 14.5 13.5h-13L8 2.25Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M8 6.5v3M8 11.5v.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>);
export const IconMinus = svg(<path d="M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />);
export const IconPlus = svg(<path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />);
export const IconFit = svg(<path d="M6 2.25H2.25V6M10 2.25h3.75V6M6 13.75H2.25V10M10 13.75h3.75V10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />);
export const IconHand = svg(<path d="M5.25 7.5V3.9a1.15 1.15 0 0 1 2.3 0v3.1m0-.6V2.9a1.15 1.15 0 0 1 2.3 0v4.1m0-.9a1.15 1.15 0 0 1 2.3 0v1.4m-9.2-.4a1.15 1.15 0 0 0-1.2 1.15c0 .3.1.6.3.85l2.4 3.1a4.2 4.2 0 0 0 3.3 1.6h.6a4.1 4.1 0 0 0 4.1-4.1V7.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />);
export const IconText = svg(<path d="M3 3.25h10M8 3.25v9.5M5.75 12.75h4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />);
export const IconImage = svg(<><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" /><circle cx="5.6" cy="6.4" r="1.1" fill="currentColor" /><path d="m2.4 11.9 3.3-3.1a1 1 0 0 1 1.4 0l2.1 2 1.3-1.2a1 1 0 0 1 1.4 0l1.8 1.7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></>);
// "block" est defini DEUX FOIS dans icons_view.mjs (objet JS -- la seconde
// declaration ecrase la premiere) : la valeur qui compte vraiment a
// l'execution est celle-ci (grille), pas le rectangle en pointilles.
export const IconBlock = svg(<path d="M4.75 1.75v12.5M11.25 1.75v12.5M1.75 4.75h12.5M1.75 11.25h12.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />);
export const IconOnion = svg(<><circle cx="8" cy="8" r="6.1" stroke="currentColor" strokeWidth="1.3" /><path d="M8 1.9a6.1 6.1 0 0 1 0 12.2V1.9Z" fill="currentColor" /></>);
export const IconPdf = svg(<><path d="M9.5 1.75h-5a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.25L9.5 1.75Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M9.25 2v2.5h2.75" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M5.75 11.25h4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></>);
