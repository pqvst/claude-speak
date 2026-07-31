// Claude Speak — toolbar icon state.
//
// The status used to be a pill injected into the page. It lives on the toolbar
// icon instead: green when the tab's relay socket is connected, red when it
// isn't, with the number of utterances spoken as the badge.
//
// This has to be a service worker because `chrome.action` is not available to
// content scripts. The content script reports its state here by message.
//
// Icons are drawn with OffscreenCanvas rather than shipped as PNGs, so there
// are no binary assets to keep in sync with the colors.

const COLORS = {
  connected: '#2ea043',
  disconnected: '#c8382e',
};

const iconCache = new Map();

function iconFor(color) {
  if (iconCache.has(color)) return iconCache.get(color);
  const imageData = {};
  for (const size of [16, 32]) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    ctx.beginPath();
    // Inset slightly so the circle isn't clipped by the icon bounds.
    ctx.arc(size / 2, size / 2, size / 2 - Math.max(1, size * 0.09), 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    imageData[size] = ctx.getImageData(0, 0, size, size);
  }
  iconCache.set(color, imageData);
  return imageData;
}

// Scoped to the reporting tab: two claude.ai tabs can have different socket
// states, and a global icon would show whichever reported last.
function apply(tabId, state) {
  const connected = Boolean(state.connected);
  const color = connected ? COLORS.connected : COLORS.disconnected;
  const count = Number(state.spokenCount) || 0;

  const options = { imageData: iconFor(color) };
  if (tabId !== undefined) options.tabId = tabId;
  // Every call can reject if the tab vanished between the message and now.
  chrome.action.setIcon(options).catch(() => {});

  const badge = { text: count ? String(count) : '' };
  if (tabId !== undefined) badge.tabId = tabId;
  chrome.action.setBadgeText(badge).catch(() => {});

  const background = { color: color };
  if (tabId !== undefined) background.tabId = tabId;
  chrome.action.setBadgeBackgroundColor(background).catch(() => {});

  const title = {
    title: connected
      ? `Claude Speak — connected${count ? `, ${count} spoken` : ''}`
      : 'Claude Speak — relay server not reachable',
  };
  if (tabId !== undefined) title.tabId = tabId;
  chrome.action.setTitle(title).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== 'claude-speak-state') return;
  apply(sender.tab && sender.tab.id, message);
});
