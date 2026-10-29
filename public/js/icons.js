// A single, consistent set of inline stroke icons shared by every page, replacing color emoji
// (which render wildly differently across OS/fonts) with something that looks the same
// everywhere and always matches the surrounding text color via currentColor.
(function () {
  const PATHS = {
    settings:
      '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
    folder: '<path d="M3 6.5a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6.5Z"/>',
    bank: '<path d="M3 10 12 4l9 6M4 10v9M9 10v9M15 10v9M20 10v9M2.5 19h19"/>',
    sliders:
      '<path d="M4 6h12M19 6h1M4 12h7M14 12h6M4 18h2M9 18h11"/><circle cx="17" cy="6" r="2"/><circle cx="11" cy="12" r="2"/><circle cx="7" cy="18" r="2"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>',
    paperclip:
      '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    trash:
      '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14ZM10 11v6M14 11v6"/>',
    thumbsUp:
      '<path d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z"/>',
    thumbsDown:
      '<path d="M17 14V2M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22h0a3.13 3.13 0 0 1-3-3.88Z"/>',
    refresh: '<path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.6M4 4v4.6h4.6M4 13a8 8 0 0 0 13.7 4.7l2.3-2.3M20 20v-4.6h-4.6"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M4 19h16"/>',
    fileText: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z"/><path d="M14 3v5h5M8 12h8M8 16h8M8 20h5"/>',
    fileSpreadsheet:
      '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z"/><path d="M14 3v5h5M8 12h8M8 16h8M11 12v8"/>',
    presentation: '<path d="M3 4h18M4 4v13h16V4M9 21l3-4 3 4"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M4 17l5-5 4 4 3-3 4 4"/>',
    check: '<path d="M4 12l5 5 11-11"/>',
    alertTriangle: '<path d="M12 3 22 20H2Z"/><path d="M12 9v5M12 17v.01"/>',
    square: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>',
    chevronDown: '<path d="M5 8l7 7 7-7"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/>',
    volume: '<path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
    columns: '<rect x="3" y="4" width="8" height="16" rx="1"/><rect x="13" y="4" width="8" height="16" rx="1"/>',
    chevronLeft: '<path d="M15 5l-7 7 7 7"/>',
    chevronRight: '<path d="M9 5l7 7-7 7"/>',
    x: '<path d="M5 5l14 14M19 5 5 19"/>',
    send: '<path d="M12 20V5M6 11l6-6 6 6"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.8-4.8"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>',
    lightbulb: '<path d="M9 18h6M10 21h4M12 2a6 6 0 0 0-4 10.5c.7.6 1 1.3 1 2.5h6c0-1.2.3-1.9 1-2.5A6 6 0 0 0 12 2Z"/>',
    book: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5v-15Z"/><path d="M4 19.5A1.5 1.5 0 0 1 5.5 18H20"/>',
    users:
      '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.5 2.5-6 6-6s6 2.5 6 6"/><path d="M16 8a3 3 0 1 1 0 5.9M20 20c0-2.8-1.7-5.2-4-6.1"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
    inbox: '<path d="M3 12h4.5l1.5 3h6l1.5-3H21"/><path d="M5.5 5h13l2.5 7v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-7Z"/>',
    barChart: '<path d="M3 21h18M6 21v-6M12 21V9M18 21V4"/>',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8"/>',
    at: '<circle cx="12" cy="12" r="4"/><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-4.5 7.79"/>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    upload: '<path d="M12 21V9M7 14l5-5 5 5M4 5h16"/>',
    helpCircle: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 4.6 1.4c0 1.6-2.1 1.8-2.1 3.4"/><path d="M12 17.5v.01"/>',
  };
  PATHS.webpage = PATHS.globe;

  function icon(name, opts) {
    opts = opts || {};
    const size = opts.size || 18;
    const body = PATHS[name];
    if (!body) return '';
    const cls = opts.className ? ` ${opts.className}` : '';
    return (
      `<svg class="icon${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
      `stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
    );
  }

  window.ICONS = PATHS;
  window.icon = icon;

  // Lets static HTML declare an icon with `<span data-icon="name"></span>` instead of embedding
  // raw SVG or an emoji directly — one shared source of truth for every page's markup.
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-icon]').forEach((el) => {
      const size = el.getAttribute('data-icon-size');
      el.innerHTML = icon(el.getAttribute('data-icon'), size ? { size: Number(size) } : {});
    });
  });
})();
