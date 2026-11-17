// The cockpit's one icon set: line icons in the header toolbar's style (24×24,
// 1.8 stroke, round caps, currentColor). Emojis render at the OS's whim —
// colour, size and baseline change from one machine to the next — so the
// interface draws these instead.
//
// A CLASSIC script (not a module), loaded before the main inline script: the
// main script paints tabs and menus while the document is still being parsed,
// and the ESM bridge is only ready after that (invariant 10). Everything hangs
// off `globalThis.LineIcons`, so the tests can load this file too.
//
// Group and folder icons are still STORED as the emoji the user picked (no
// migration, nothing for the server or Telegram to learn): `paint` draws the
// line icon mapped to that emoji, and only an emoji with no mapping — one the
// user typed — is shown as itself.
(function () {
  const P = {
    // The header toolbar's own drawings, reused verbatim.
    key: '<circle cx="8.5" cy="8.5" r="3.5"/><path d="M11 11l7.5 7.5M15.5 15.5l1.8-1.8M17.8 17.8l1.7-1.7"/>',
    context: '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/>',
    flask: '<path d="M9 3.5h6M10 3.5v5.5l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3.5M7.5 15h9"/>',
    profile: '<circle cx="12" cy="8.5" r="3.6"/><path d="M5.5 19.5a6.5 6.5 0 0 1 13 0"/>',
    shield: '<path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z"/>',
    flag: '<path d="M6 21V4M6 4h11l-2.5 4L17 12H6"/>',
    users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3 19a6 6 0 0 1 12 0"/><path d="M16 6.2a3.2 3.2 0 0 1 0 6.1M17.5 19a6 6 0 0 0-2.2-4.6"/>',
    bell: '<path d="M6 16.5h12c-1.3-1.1-2-2.7-2-4.5v-1.2a4 4 0 0 0-8 0v1.2c0 1.8-.7 3.4-2 4.5z"/><path d="M10.4 19a1.7 1.7 0 0 0 3.2 0"/>',
    mute: '<path d="M6 16.5h12c-1.3-1.1-2-2.7-2-4.5v-1.2a4 4 0 0 0-8 0v1.2c0 1.8-.7 3.4-2 4.5z"/><path d="M10.4 19a1.7 1.7 0 0 0 3.2 0"/><path d="M4.5 4.5l15 15"/>',
    telegram: '<path fill="#26A5E4" stroke="none" d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>',
    gallery: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="8.5" cy="9.5" r="1.4" fill="currentColor" stroke="none"/><path d="M5 17l4.5-4.5 3 3 2.5-2.5L19 16"/>',
    schedule: '<circle cx="12" cy="13" r="6.3"/><path d="M12 9.8V13l2.2 1.4"/><path d="M4.8 6.6 7.2 4.6M19.2 6.6 16.8 4.6"/>',
    bolt: '<path d="M13 2.5 5.5 13.5H11l-1 8L18.5 10H13z"/>',
    info: '<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M14.5 4v16"/><path d="M6.5 9h5M6.5 12.5h5M6.5 16h3" stroke-width="1.6"/>',
    terminal: '<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="M6 9.5l3 2.5-3 2.5M12.5 15h5"/>',
    paperclip: '<path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9"/>',
    sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" stroke-width="1.6"/>',
    // Drawn for the cockpit, same grammar.
    model: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 3.5V7M14 3.5V7M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5"/>',
    effort: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l3.6-4.6"/>',
    stats: '<path d="M6 19v-6M12 19V6M18 19v-9"/>',
    trend: '<path d="M3.5 17l6-6 4 4 7-7.5"/><path d="M15 7.5h5.5V13"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
    rename: '<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M13.5 8.5l3 3"/>',
    reload: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
    close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    chat: '<path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 5z"/>',
    folder: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5v7.8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
    folderOpen: '<path d="M3.5 17.5v-10A1.5 1.5 0 0 1 5 6h4.2l2 2.2H17a1.5 1.5 0 0 1 1.5 1.5v1"/><path d="M3.5 17.5l2.2-5.6a1.5 1.5 0 0 1 1.4-.9h13a.8.8 0 0 1 .75 1.1L18.6 18a1.5 1.5 0 0 1-1.4 1H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
    archive: '<rect x="3.5" y="4" width="17" height="5" rx="1"/><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M10 13h4"/>',
    inbox: '<path d="M3.5 13l2.6-7a1.5 1.5 0 0 1 1.4-1h9a1.5 1.5 0 0 1 1.4 1l2.6 7v5.5A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M3.5 13H8l1.5 2.5h5L16 13h4.5"/>',
    home: '<path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-4v-6h-5v6h-4A1.5 1.5 0 0 1 4 19z"/>',
    lock: '<rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    building: '<rect x="5" y="3.5" width="14" height="17" rx="1.5"/><path d="M9 7.5h1.5M13.5 7.5H15M9 11.5h1.5M13.5 11.5H15M10 20.5v-4h4v4"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
    plug: '<path d="M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0zM12 16.5V21"/>',
    history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 4v4h4"/><path d="M12 7.5V12l3 2"/>',
    hourglass: '<path d="M6.5 3.5h11M6.5 20.5h11M7.5 3.5c0 4.5 4.5 5.5 4.5 8.5s-4.5 4-4.5 8.5M16.5 3.5c0 4.5-4.5 5.5-4.5 8.5s4.5 4 4.5 8.5"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    compress: '<path d="M4 12h16M12 3v5.5M9.5 6 12 8.5 14.5 6M12 21v-5.5M9.5 18l2.5-2.5 2.5 2.5"/>',
    bug: '<rect x="7.5" y="8" width="9" height="12" rx="4.5"/><path d="M12 12v8M9 8a3 3 0 0 1 6 0M3.5 13h4M16.5 13h4M4.5 8.5l3 2M19.5 8.5l-3 2M4.5 19l3-2.5M19.5 19l-3-2.5"/>',
    blocked: '<circle cx="12" cy="12" r="9"/><path d="M7.5 12h9"/>',
    rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
    tools: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    box: '<path d="M21 7.5l-9-4.5-9 4.5 9 4.5 9-4.5z"/><path d="M3 7.5v9l9 4.5 9-4.5v-9"/><path d="M12 12v9"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3"/>',
    sprout: '<path d="M7 20h10"/><path d="M10 20c5.5-2.5.8-6.4 3-10"/><path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z"/><path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z"/>',
    puzzle: '<path d="M19.44 7.85c-.05.32.06.65.29.88l1.57 1.57c.47.47.7 1.09.7 1.7s-.23 1.23-.7 1.7l-1.61 1.61a.98.98 0 0 1-.84.28c-.47-.07-.8-.48-.97-.93a2.5 2.5 0 1 0-3.21 3.21c.45.17.86.5.93.97a.98.98 0 0 1-.28.84l-1.61 1.61a2.4 2.4 0 0 1-1.7.7 2.4 2.4 0 0 1-1.7-.7l-1.57-1.57a1.03 1.03 0 0 0-.88-.29c-.49.07-.84.5-1.02.97a2.5 2.5 0 1 1-3.24-3.24c.46-.18.9-.53.97-1.02a1.03 1.03 0 0 0-.29-.88l-1.57-1.57A2.4 2.4 0 0 1 2 12c0-.62.24-1.23.7-1.7L4.23 8.77c.24-.24.58-.35.92-.3.51.08.88.53 1.07 1.01a2.5 2.5 0 1 0 3.26-3.26c-.48-.2-.93-.56-1.01-1.07-.05-.34.06-.68.3-.92L10.3 2.7A2.4 2.4 0 0 1 12 2c.62 0 1.23.24 1.7.7l1.57 1.57c.23.23.56.34.88.29.49-.07.84-.5 1.02-.97a2.5 2.5 0 1 1 3.24 3.24c-.46.18-.9.53-.97 1.02z"/>',
    palette: '<path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1" fill="currentColor" stroke="none"/><circle cx="10" cy="7" r="1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="7" r="1" fill="currentColor" stroke="none"/>',
    megaphone: '<path d="M3.5 10v4a1 1 0 0 0 1 1H7l7 4V5L7 9H4.5a1 1 0 0 0-1 1z"/><path d="M17.5 9a4 4 0 0 1 0 6"/><path d="M8 15l1 4.5"/>',
    antenna: '<path d="M12 13v8"/><circle cx="12" cy="11" r="2"/><path d="M8.2 7.2a5.5 5.5 0 0 0 0 7.6M15.8 7.2a5.5 5.5 0 0 1 0 7.6M5.4 4.4a9.5 9.5 0 0 0 0 13.2M18.6 4.4a9.5 9.5 0 0 1 0 13.2"/>',
    flame: '<path d="M12 21a6 6 0 0 0 6-6c0-3.5-2.5-5.5-3.5-8.5-.5 2-1.5 3-2.5 3.5C12 7 11 4.5 9 3c.3 3-3 5.5-3 10a6 6 0 0 0 6 8z"/>',
    bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
    laptop: '<rect x="4.5" y="5" width="15" height="10" rx="1.5"/><path d="M2.5 19h19"/>',
    factory: '<path d="M3 20.5h18V4h-3.5v8L13 9v3L8 9v3L3 9z"/><path d="M7 16.5h1.5M11.25 16.5h1.5M15.5 16.5H17"/>',
    star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
    coins: '<circle cx="9" cy="9" r="5.5"/><path d="M15.5 9.6a5.5 5.5 0 1 1-6 6"/>',
    cart: '<circle cx="9" cy="20" r="1.2"/><circle cx="18" cy="20" r="1.2"/><path d="M2.5 3.5h2.6l2.2 11.2a1.5 1.5 0 0 0 1.5 1.3h8.6a1.5 1.5 0 0 0 1.5-1.2L20.5 8H6.2"/>',
    bot: '<rect x="4.5" y="8" width="15" height="11" rx="2.5"/><path d="M12 8V5M9 13v1.5M15 13v1.5M2.5 13h2M19.5 13h2"/><circle cx="12" cy="4" r="1" fill="currentColor" stroke="none"/>',
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18h2"/>',
    cloud: '<path d="M7 18.5h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6 9.5a4.5 4.5 0 0 0 1 9z"/>',
    database: '<ellipse cx="12" cy="6" rx="7.5" ry="2.8"/><path d="M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
    mail: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>',
    graduation: '<path d="M2.5 9.5 12 5l9.5 4.5L12 14z"/><path d="M6.5 11.5V16c0 1.4 2.5 3 5.5 3s5.5-1.6 5.5-3v-4.5M21.5 9.5v5"/>',
    book: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z"/>',
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7M3 12.5h18"/>',
    code: '<path d="M8.5 7.5 4 12l4.5 4.5M15.5 7.5 20 12l-4.5 4.5"/>',
    camera: '<path d="M4 8h3l1.5-2.5h7L17 8h3a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
    pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
    music: '<path d="M9 18V5.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  };

  // Group / folder icons: the emoji(s) a stored icon may hold → the line icon
  // drawn for it, with the words the picker's search answers to. The FIRST emoji
  // of a row is the one written when the icon is picked.
  const GLYPHS = [
    [["📁"], "folder", "folder files directory"],
    [["📂"], "folderOpen", "folder open"],
    [["🚀"], "rocket", "rocket launch ship release startup"],
    [["🧪", "⚗"], "flask", "flask lab test experiment science"],
    [["🛠", "🔧", "🔨", "⚒"], "tools", "tools build maintenance fix wrench hammer devops"],
    [["📦"], "box", "box package delivery shipping product"],
    [["🎯"], "target", "target goal objective focus"],
    [["🧭"], "compass", "compass explore direction strategy"],
    [["🔬", "🔍", "🔎"], "search", "search research analysis investigate microscope"],
    [["🌱", "🌿", "🍀"], "sprout", "sprout plant growth green seed"],
    [["⚡"], "bolt", "bolt fast energy power lightning"],
    [["🧩"], "puzzle", "puzzle integration plugin piece"],
    [["📊"], "stats", "chart stats data metrics analytics dashboard"],
    [["📈"], "trend", "trend growth sales up kpi"],
    [["🔒", "🔐"], "lock", "lock security private secret"],
    [["🎨"], "palette", "palette design art creative ui"],
    [["📣", "📢"], "megaphone", "megaphone marketing announce communication"],
    [["🐛", "🐞"], "bug", "bug issue qa debug"],
    [["🗂"], "archive", "archive folders index organize"],
    [["🗄"], "database", "database storage data sql"],
    [["🛰", "📡"], "antenna", "antenna satellite signal network monitoring"],
    [["🔥"], "flame", "flame fire hot urgent incident"],
    [["💡"], "bulb", "bulb idea innovation"],
    [["💻", "🖥"], "laptop", "laptop computer engineering dev code"],
    [["🛡"], "shield", "shield security compliance protection"],
    [["🏭"], "factory", "factory industry production supplier"],
    [["📥"], "inbox", "inbox main general"],
    [["🏠", "🏡"], "home", "home house personal"],
    [["⭐", "🌟"], "star", "star favorite important"],
    [["💰", "💶", "💵", "💳"], "coins", "money finance budget billing coins"],
    [["🛒"], "cart", "cart shop ecommerce store"],
    [["📝", "📄", "📋"], "context", "note document doc writing content"],
    [["🤖"], "bot", "bot robot ai agent automation"],
    [["📱"], "phone", "phone mobile app"],
    [["☁"], "cloud", "cloud infra hosting"],
    [["✉", "📧", "📨"], "mail", "mail email newsletter"],
    [["📅", "📆", "🗓"], "calendar", "calendar planning events"],
    [["❤", "💜", "💙"], "heart", "heart love care support"],
    [["🔑", "🗝"], "key", "key access credentials"],
    [["🔗"], "link", "link url partners"],
    [["🎓"], "graduation", "graduation school training learning"],
    [["📚", "📖"], "book", "book docs knowledge wiki"],
    [["💼"], "briefcase", "briefcase business work sales client"],
    [["👨‍💻", "⌨"], "code", "code developer programming"],
    [["🚩", "🏁"], "flag", "flag milestone"],
    [["📷", "📸"], "camera", "camera photo media"],
    [["📍"], "pin", "pin location map place"],
    [["🎵", "🎶"], "music", "music audio sound"],
    [["🌐", "🌍", "🌎", "🌏"], "globe", "globe world web international public"],
    [["👥"], "users", "users team people group"],
    [["👤"], "profile", "person profile user"],
    [["🏢"], "building", "building company office"],
    [["⚙"], "gear", "gear settings config"],
    [["💬"], "chat", "chat conversation room talk"],
    [["⏰"], "schedule", "schedule clock time alarm"],
    [["🔔"], "bell", "bell notification alert"],
  ];

  const norm = (s) => String(s ?? "").replace(/️/g, "").trim();
  const byEmoji = new Map();
  for (const [emojis, name] of GLYPHS) for (const e of emojis) byEmoji.set(norm(e), name);

  /** The SVG markup of a line icon ("" for an unknown name). */
  function svg(name, size = 15) {
    const p = P[name];
    if (!p) return "";
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  }
  /** A `<span class="ico">` holding a line icon. */
  function el(name, size = 15, cls = "ico") {
    const s = document.createElement("span");
    s.className = cls;
    s.innerHTML = svg(name, size);
    return s;
  }
  /** The line icon drawn for a stored emoji, or null when it has none. */
  function forEmoji(emoji) {
    return byEmoji.get(norm(emoji)) || null;
  }
  /** Draw a stored group/folder icon into `target`: its line icon when the
   *  emoji is mapped, the emoji itself otherwise. Skips the repaint when nothing
   *  changed (the rail and the folder heads repaint on every frame of activity). */
  function paint(target, value, size = 15) {
    const key = String(value ?? "") + "@" + size;
    if (target.dataset.glyph === key) return;
    target.dataset.glyph = key;
    const name = forEmoji(value);
    if (name) target.innerHTML = svg(name, size);
    else target.textContent = String(value ?? "");
  }
  /** The picker's search: the stored emoji of every icon whose words or name
   *  start with each typed word. */
  function search(query) {
    const words = norm(query).toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return GLYPHS
      .filter(([, name, kw]) => {
        const hay = (name + " " + kw).toLowerCase().split(/\s+/);
        return words.every((w) => hay.some((h) => h.startsWith(w)));
      })
      .map(([emojis]) => emojis[0]);
  }
  /** What the picker offers with an empty search: every icon, once. */
  const PICKER = GLYPHS.filter(([, name]) => name !== "folderOpen").map(([emojis]) => emojis[0]);

  /** Static markup asks for an icon with `data-ico="name"` (optional
   *  `data-ico-size`); it is put in front of the element's own text. */
  function hydrate(root) {
    for (const n of (root || document).querySelectorAll("[data-ico]:not([data-ico-done])")) {
      n.setAttribute("data-ico-done", "");
      n.prepend(el(n.getAttribute("data-ico"), Number(n.getAttribute("data-ico-size")) || 14));
    }
  }

  globalThis.LineIcons = { svg, el, forEmoji, paint, search, hydrate, PICKER, names: Object.keys(P), glyphs: GLYPHS };
  if (typeof document !== "undefined") {
    hydrate(document);
    document.addEventListener("DOMContentLoaded", () => hydrate(document));
  }
})();
