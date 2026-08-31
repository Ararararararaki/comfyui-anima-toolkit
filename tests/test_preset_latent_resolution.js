// TK 空 Latent 分辨率快捷操作的纯逻辑回归测试。
// 只执行真实前端文件中的计算函数，不需要启动 ComfyUI 或浏览器。
const fs = require("fs");

const file = "E:/claude program/ComfyUI-Anima-Batch-LoRA/web/js/anima_preset_latent_widget.js";
const source = fs.readFileSync(file, "utf8");
const start = source.indexOf("const RESOLUTION_MULTIPLE");
const end = source.indexOf("function ensureStyles", start);
if (start < 0 || end < 0) throw new Error("无法定位分辨率计算函数");

const resolution = Function(`${source.slice(start, end)}\nreturn { snapResolution, calculateRatioResolution, longEdgeScaleOf, formatScale, normalizeWidgetResolution };`)();

function assertEqual(label, actual, expected) {
  const received = JSON.stringify(actual);
  const wanted = JSON.stringify(expected);
  if (received !== wanted) throw new Error(`${label}：得到 ${received}，期望 ${wanted}`);
}

assertEqual("取整到 16 的倍数", resolution.snapResolution(1025), 1024);
assertEqual("1536 标准长边正方形", resolution.calculateRatioResolution(1536, 1, 1, 1), { width: 1536, height: 1536 });
assertEqual("16:9 标准长边", resolution.calculateRatioResolution(1536, 16, 9, 1), { width: 1536, height: 864 });
assertEqual("9:16 标准长边", resolution.calculateRatioResolution(1536, 9, 16, 1), { width: 864, height: 1536 });
assertEqual("标准长边倍率", resolution.longEdgeScaleOf(1536, 864), 1);
assertEqual("标准长边半倍率", resolution.longEdgeScaleOf(1024, 1024), 1024 / 1536);
assertEqual("倍率显示", resolution.formatScale(1.5), "×1.50");
assertEqual("遵守控件最大值并保持 16 倍数", resolution.normalizeWidgetResolution({ options: { min: 16, max: 2048 } }, 2300), 2048);

console.log("PASS TK 空 Latent 比例分辨率计算");
