// Shared image + prompt hover surface. One active surface across gallery nodes.
let activePreview = null;

export function galleryHoverImageUrl(post, sourceId, previewUrl) {
  const full = post.full_url || post.file_url || "";
  const video = /^(mp4|webm|m4v|mov|mkv)$/i.test(post.file_ext || post.meta?.file_ext || "")
    || /\.(mp4|webm|m4v|mov|mkv)(?:[?#]|$)/i.test(full);
  const candidates = video
    ? [post.preview_file_url, post.preview_url, previewUrl]
    : [post.sample_url, post.meta?.sample_url, post.large_file_url, full, previewUrl];
  const url = candidates.find(value => value && !/\.(mp4|webm|m4v|mov|mkv)(?:[?#]|$)/i.test(value)) || "";
  // Civitai's image transform stays on the same CDN; never fetch an original for hover.
  return sourceId === "civitai" ? url.replace(/\/width=\d+(?=[,/])/, "/width=1200") : url;
}

export function galleryHoverPlacement(card, gallery, desiredWidth, height, vw, vh) {
  const padding = 12, gap = 10;
  const rightSpace = vw - gallery.right - gap - padding;
  const leftSpace = gallery.left - gap - padding;
  let width = Math.min(desiredWidth, Math.max(0, vw - padding * 2));
  let left;
  // Prefer the outside of the whole node, leaving the next images available to select.
  if (Math.max(rightSpace, leftSpace) >= 280) {
    const right = rightSpace >= leftSpace;
    width = Math.min(width, right ? rightSpace : leftSpace);
    left = right ? gallery.right + gap : gallery.left - gap - width;
  } else {
    const flipped = card.left - gap - width;
    left = card.right + gap + width <= vw - padding ? card.right + gap
      : flipped >= padding ? flipped : Math.max(padding, vw - padding - width);
  }
  const top = Math.max(padding, Math.min(card.top, vh - height - padding));
  return { left: Math.round(left), top: Math.round(top), width: Math.floor(width) };
}

export class GalleryHoverPreview {
  constructor({ title, imageUrl, thumbnailUrl, hasDetails, aspectRatio = 1, selected, onClose, onExpand, onSelect }) {
    activePreview?.onClose();
    activePreview = this;
    this.onClose = onClose;
    this.hasDetails = hasDetails;
    this.element = document.createElement("div");
    this.element.className = "adg-prompt-tooltip adg-hover-preview";
    this.element.classList.toggle("is-landscape", aspectRatio > 1.2);
    this.element.setAttribute("role", "region");
    this.element.setAttribute("aria-label", title);
    this.element.dataset.captureWheel = "true";
    const header = document.createElement("div");
    header.className = "adg-hover-header";
    const label = document.createElement("strong");
    label.textContent = title;
    header.append(label);
    this.selectButton = document.createElement("button");
    this.selectButton.type = "button";
    this.selectButton.setAttribute("aria-label", "选择悬浮预览图片");
    this.selectButton.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation(); onSelect();
    });
    header.append(this.selectButton);
    for (const [text, action] of [["放大查看", onExpand], ["收起", () => onClose(true)]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      button.setAttribute("aria-label", `${text}悬浮预览`);
      button.addEventListener("click", event => {
        event.preventDefault(); event.stopPropagation(); action();
      });
      header.append(button);
    }
    const body = document.createElement("div");
    body.className = "adg-hover-body";
    const media = document.createElement("button");
    media.className = "adg-hover-media";
    media.type = "button";
    media.setAttribute("aria-label", "点击大图选择或取消选择");
    media.title = "点击大图选择或取消选择";
    media.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation(); onSelect();
    });
    this.media = media;
    this.image = document.createElement("img");
    this.image.alt = title;
    this.image.decoding = "async";
    // Keep an already-loaded thumbnail visible while the larger sample arrives.
    if (thumbnailUrl && thumbnailUrl !== imageUrl) {
      this.thumbnail = document.createElement("img");
      this.thumbnail.alt = "";
      this.thumbnail.src = thumbnailUrl;
      media.append(this.thumbnail);
    }
    this.image.onload = () => {
      this.thumbnail?.remove();
      this.element.classList.toggle("is-landscape", this.image.naturalWidth > this.image.naturalHeight * 1.2);
    };
    this.image.onerror = () => {
      this.image.removeAttribute("src");
      const note = document.createElement("span");
      note.className = "adg-hover-image-note";
      note.textContent = this.thumbnail ? "大图暂未加载，显示缩略图" : "图片暂不可用，可点「放大查看」重试";
      media.append(note);
    };
    this.image.src = imageUrl;
    media.append(this.image);
    this.details = document.createElement("div");
    this.details.className = "adg-hover-details";
    this.details.hidden = !hasDetails;
    body.append(media, this.details);
    this.element.append(header, body);
    this.setSelected(selected);
    this.element.addEventListener("wheel", event => event.stopPropagation(), { capture: true });
    this.onKeyDown = event => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(true); }
    };
    this.onResize = () => onClose();
    document.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("resize", this.onResize);
  }

  position(card, gallery) {
    const cardRect = card.getBoundingClientRect();
    const galleryRect = gallery.getBoundingClientRect();
    const desiredWidth = this.hasDetails ? 620 : 420;
    const placement = galleryHoverPlacement(cardRect, galleryRect, desiredWidth, 0, window.innerWidth, window.innerHeight);
    this.element.style.width = `${placement.width}px`;
    this.element.classList.toggle("is-compact", placement.width < 480);
    const final = galleryHoverPlacement(cardRect, galleryRect, desiredWidth, this.element.getBoundingClientRect().height, window.innerWidth, window.innerHeight);
    this.element.style.left = `${final.left}px`;
    this.element.style.top = `${final.top}px`;
  }

  setSelected(selected) {
    this.selectButton.textContent = selected ? "已选" : "选择此图";
    this.selectButton.setAttribute("aria-pressed", String(!!selected));
    this.media.setAttribute("aria-pressed", String(!!selected));
    this.media.classList.toggle("is-selected", !!selected);
  }

  dispose() {
    if (activePreview === this) activePreview = null;
    document.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("resize", this.onResize);
    this.image.onload = this.image.onerror = null;
    this.image.removeAttribute("src");
    this.thumbnail?.removeAttribute("src");
    this.element.remove();
  }
}
