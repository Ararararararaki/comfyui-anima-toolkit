// TK Camera Control 前端方位权重映射回归测试。
// 直接抽取真实 widget 的计算函数，避免只测后端而漏掉前端预览曲线。
const fs = require('fs');

const file = 'E:/claude program/ComfyUI-Anima-Batch-LoRA/web/js/anima_camera_control_widget.js';
const source = fs.readFileSync(file, 'utf8');
const start = source.indexOf('const DEFAULT_CONFIG');
const end = source.indexOf('const esc', start);
if (start < 0 || end < 0) throw new Error('无法定位 TK Camera Control 计算区');
const camera = Function(`${source.slice(start, end)}\nreturn { loadConfig, computeCamera };`)();

const config = camera.loadConfig(JSON.stringify({
  weight_max: 5,
  elevation: { enabled: false },
  distance: { enabled: false },
  tilt: { enabled: false },
}));

function weightAt(posX, tag) {
  const prompt = camera.computeCamera(posX, 0, 0, 0, '', config);
  const match = new RegExp(`\\(${tag.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}:([0-9.]+)\\)`).exec(prompt);
  return match ? Number(match[1]) : null;
}

function assertContinuous(label, values) {
  if (values.some((value, index) => index > 0 && value <= values[index - 1])) {
    throw new Error(`${label} 未连续上升: ${values.join(', ')}`);
  }
}

const left = [0.25, 0.35, 0.45, 0.50].map((x) => weightAt(x, 'from left'));
const right = [0.25, 0.35, 0.45, 0.50].map((x) => weightAt(-x, 'from right'));
const behind = [0.75, 0.85, 0.95, 1.00].map((x) => weightAt(x, 'from behind'));
assertContinuous('from left', left);
assertContinuous('from right', right);
assertContinuous('from behind', behind);
if (left.at(-1) !== 5 || right.at(-1) !== 5 || behind.at(-1) !== 5) {
  throw new Error(`最大权重不正确: ${JSON.stringify({ left, right, behind })}`);
}
console.log('PASS TK 相机前端左右/背面方位权重连续变化', JSON.stringify({ left, right, behind }));
