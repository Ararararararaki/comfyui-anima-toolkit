/** Screen geometry shared by every completion mode; independent of canvas scale. */
export function suggestionBounds(rect, viewport, desiredHeight = 360, minWidth = 300) {
  const margin = 8;
  const vw = Math.max(1, viewport.width), vh = Math.max(1, viewport.height);
  const width = Math.min(Math.max(rect.width, minWidth), Math.max(1, vw - margin * 2));
  const left = Math.max(margin, Math.min(rect.left, vw - width - margin));
  const anchorTop = Math.max(margin, Math.min(rect.top, vh - margin));
  const anchorBottom = Math.max(margin, Math.min(rect.bottom, vh - margin));
  const above = Math.max(0, anchorTop - margin - 3);
  const below = Math.max(0, vh - anchorBottom - margin - 3);
  const upward = below < Math.min(180, desiredHeight) && above > below;
  const maxHeight = Math.min(desiredHeight, upward ? above : below);
  return { left, width, maxHeight, upward, anchorTop, anchorBottom };
}

export function positionGallerySuggestions(input, box) {
  if (!input || !box || box.style.display === 'none') return;
  const view = input.ownerDocument.defaultView;
  const bounds = suggestionBounds(input.getBoundingClientRect(), { width: view.innerWidth, height: view.innerHeight });
  Object.assign(box.style, { left: bounds.left + 'px', width: bounds.width + 'px', maxHeight: bounds.maxHeight + 'px' });
  box.style.top = Math.max(8, bounds.upward ? bounds.anchorTop - box.offsetHeight - 3 : bounds.anchorBottom + 3) + 'px';
}

/** Aspect-ratio masonry preserves the absolute-position/scroll-anchor contract. */
export function layoutGalleryGrid(ui, gap = 7) {
  const grid = ui.grid;
  if (!grid || ui.workspacePaused) return;
  const cards = [...grid.querySelectorAll('.adg-card')];
  const style = getComputedStyle(grid);
  const left = parseFloat(style.paddingLeft) || 0, top = parseFloat(style.paddingTop) || 0;
  const usable = Math.max(1, grid.clientWidth - left - (parseFloat(style.paddingRight) || 0));
  const target = ui.thumbTargetPt();
  const posts = ui._layoutPosts || ui.posts || [];
  const browseActive = ui.browseActive?.();
  const pages = cards.map((card, i) => browseActive ? ui._browsePostPages?.get(ui.postKeyOf(posts[i])) : null);
  const pageStamp = pages.join(',') + ':' + ui.browseState?.pageNumbers;
  const cached = ui._regularLayout;
  if (cached && cached.usable === usable && cached.top === top && cached.left === left
      && cached.target === target && cached.posts === posts && cached.browse === ui.browseState && cached.pageStamp === pageStamp
      && cached.cards.length === cards.length && cards.every((card, i) => cached.cards[i] === card)) return;
  ui._regularLayout = { usable, top, left, target, posts, browse: ui.browseState, pageStamp, cards };
  const cols = Math.max(1, Math.floor((usable + gap) / (target + gap)));
  const width = (usable - gap * (cols - 1)) / cols;
  for (const marker of grid.querySelectorAll('.adg-page-boundary')) marker.remove();
  let heights = Array(cols).fill(top), previousPage = null, summedHeight = 0;
  cards.forEach((card, index) => {
    const page = pages[index];
    if (page && page !== previousPage) {
      const y = Math.max(...heights);
      const marker = document.createElement('div');
      marker.className = 'adg-page-boundary'; marker.dataset.page = String(page);
      marker.textContent = `第 ${page} ${ui.browseState.pageNumbers ? '页' : '批'}`;
      Object.assign(marker.style, { position: 'absolute', top: y + 'px', left: left + 'px', width: usable + 'px', height: '24px' });
      grid.append(marker); heights.fill(y + 28); previousPage = page;
    }
    if (page) card.dataset.browsePage = String(page); else delete card.dataset.browsePage;
    card.dataset.adgSpan = '1';
    const post = posts[index];
    const imageWidth = Number(post?.image_width), imageHeight = Number(post?.image_height);
    const ratio = imageWidth > 0 && imageHeight > 0 && Number.isFinite(imageHeight / imageWidth) ? imageHeight / imageWidth : 1.22;
    const height = Math.max(25, Math.round(Math.max(1, width - 8) * ratio + 24));
    const col = heights.indexOf(Math.min(...heights));
    const y = heights[col];
    Object.assign(card.style, { position: 'absolute', left: (left + col * (width + gap)) + 'px', top: y + 'px', width: width + 'px', height: height + 'px' });
    heights[col] = y + height + gap;
    summedHeight += height;
  });
  const total = Math.max(0, Math.max(...heights) - top - gap);
  ui._layoutTotal = total; ui._layoutMinCol = Math.max(0, Math.min(...heights) - top - gap);
  ui._measuredAvgCardH = cards.length ? summedHeight / cards.length : 24; ui.lastCols = cols; ui.lastColStep = width + gap;
  grid.style.minHeight = '0';
  const continuation = grid.querySelector('.adg-browse-continuation');
  if (continuation && top + total >= (parseFloat(continuation.style.top) || 0)) continuation.remove();
}
