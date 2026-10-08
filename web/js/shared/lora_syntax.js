// Pure syntax/disabled-state policy. Persist snapshot.disabledMap before publishing snapshot.text to the host.
export const normalizeLoraName = value => String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
const finiteWeight = (value, fallback = 1) => Number.isFinite(parseFloat(value)) ? parseFloat(value) : fallback;

export function parseLoraSyntax(text, { disabledMap = {}, disabledNames = [] } = {}) {
  const items = [], re = /<lora:([^:>]+):([^:>]+)(?::([^:>]+))?>/gi;
  let match;
  while ((match = re.exec(String(text || ''))) !== null) {
    const weight = finiteWeight(match[2]);
    items.push({ name: match[1], weight, clipWeight: match[3] === undefined ? weight : finiteWeight(match[3]), disabled: false });
  }
  for (const [name, saved] of Object.entries(disabledMap || {})) {
    const item = items.find(row => normalizeLoraName(row.name) === normalizeLoraName(name));
    if (!item) continue;
    item.disabled = true;
    if (saved && typeof saved === 'object') {
      item.weight = finiteWeight(saved.weight, item.weight);
      item.clipWeight = finiteWeight(saved.clipWeight, item.weight);
    } else {
      item.weight = finiteWeight(saved, item.weight);
      item.clipWeight = item.weight;
    }
  }
  const preferred = new Set([...disabledNames].map(normalizeLoraName));
  for (const item of items) if (preferred.has(normalizeLoraName(item.name))) item.disabled = true;
  return items;
}

export function serializeLoraSyntax(items) {
  return items.map(item => {
    const weight = Number.isFinite(item.weight) ? item.weight : 1;
    const clipWeight = Number.isFinite(item.clipWeight) ? item.clipWeight : weight;
    const model = item.disabled ? 0 : weight, clip = item.disabled ? 0 : clipWeight;
    return `<lora:${item.name}:${model.toFixed(2)}${clip === model ? '' : ':' + clip.toFixed(2)}>`;
  }).join(' ');
}

export function loraDisabledMap(items) {
  const saved = {};
  for (const item of items) {
    if (!item.disabled) continue;
    const weight = Number.isFinite(item.weight) ? item.weight : 1;
    const clipWeight = Number.isFinite(item.clipWeight) ? item.clipWeight : weight;
    saved[item.name] = weight === clipWeight ? weight : { weight, clipWeight };
  }
  return saved;
}

export const LoRASyntax = Object.freeze({
  parse: parseLoraSyntax,
  serialize: serializeLoraSyntax,
  disabledMap: loraDisabledMap,
  snapshot: items => ({ text: serializeLoraSyntax(items), disabledMap: loraDisabledMap(items) }),
});
