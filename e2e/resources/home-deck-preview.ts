import { readFileSync } from 'node:fs';

// A browser-only layout fixture: use the production PreviewCard/PreviewSurface
// class structure and complete stylesheets, without starting daemon/web or
// inventing a stored deck record. The hook's cover-scale contract has separate
// ownership tests; this fixture supplies its measured value to the CSS consumer.
export function homeDeckPreviewFixture(): string {
  const css = [
    '../../packages/components/src/preview-card.module.css',
    '../../apps/web/src/styles/home/plugins-home.css',
    '../../apps/web/src/styles/home/home-hero.css',
  ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
  // The 1.31:1 baked capture has a centered 16:9 slide between black bars.
  const poster = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1310" height="1000"><rect width="1310" height="1000" fill="black"/><rect y="131.5625" width="1310" height="736.875" fill="#00cc66"/></svg>')}`;
  // A website capture with modest authored margins and top-edge detail.
  // The marker and heading must survive thumbnail fitting; arbitrary zoom
  // crops the marker, while outer gutters waste the reserved media frame.
  const websitePoster = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1310" height="1000"><rect width="1310" height="1000" fill="white"/><rect x="40" y="40" width="1230" height="680" fill="#00cc66"/><rect x="45" y="45" width="45" height="45" fill="#ff0000"/><text x="110" y="180" font-family="monospace" font-size="100" fill="black">READABLE</text></svg>')}`;
  const card = (kind: 'media' | 'html' | 'website') => `
    <span class="home-hero__plugin-preset-cell">
      <button class="card home-hero__plugin-preset" data-od-mode="${kind === 'website' ? 'prototype' : 'deck'}" data-kind="${kind}">
        <span class="media home-hero__plugin-preset-preview">
          <div class="plugins-home__preview plugins-home__preview--${kind === 'html' ? 'html' : 'media'}">
            ${kind !== 'html' ? `<div class="plugins-home__media"><img class="plugins-home__media-img" alt="${kind === 'media' ? 'Baked deck' : 'Website'} poster" src="${kind === 'media' ? poster : websitePoster}"/><video class="plugins-home__media-video" poster="${kind === 'media' ? poster : websitePoster}"></video></div>` : '<div class="plugins-home__html"><div class="plugins-home__html-frame"><iframe class="plugins-home__html-iframe" title="Authored deck" srcdoc="<style>html,body{margin:0;width:1280px;height:720px;background:#00cc66}</style>"></iframe></div></div>'}
          </div>
        </span>
        <span class="caption"><span class="title">Representative deck</span><span class="description">Example</span></span>
      </button>
    </span>`;
  return `<!doctype html><html><head><style>
    :root { --bg-panel: #222; --bg-subtle: #333; --border: #444; }
    * { box-sizing: border-box; }
    body { margin: 20px; }
    ${css}
  </style></head><body><div class="home-hero__plugin-presets-wrap"><div class="home-hero__plugin-presets">${card('media')}${card('html')}${card('website')}</div></div></body></html>`;
}
