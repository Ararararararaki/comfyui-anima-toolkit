# -*- coding: utf-8 -*-
"""验证 DashScope OpenAI 兼容接口连通性 + 写 LLM 配置。"""
import json, os, urllib.request, sys

def get_env(name):
    v = os.environ.get(name)
    if v:
        return v
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as k:
            v, _ = winreg.QueryValueEx(k, name)
        return str(v) if v else None
    except Exception:
        return None

KEY = get_env("DASHSCOPE_API_KEY") or ""
BASE = (get_env("DASHSCOPE_BASE_URL") or
        "https://dashscope.aliyuncs.com/compatible-mode/v1").rstrip("/")
MODEL = get_env("DASHSCOPE_MODEL") or "qwen-turbo"

if not KEY:
    print("FAIL: DASHSCOPE_API_KEY 未设置")
    sys.exit(1)

# 1) 连通性测试
payload = {
    "model": MODEL,
    "messages": [
        {"role": "system", "content": "只回复两个字：正常。"},
        {"role": "user", "content": "你好"},
    ],
    "temperature": 0.1,
    "max_tokens": 16,
}
req = urllib.request.Request(BASE + "/chat/completions",
                             data=json.dumps(payload).encode(),
                             headers={"Content-Type": "application/json",
                                      "Authorization": "Bearer " + KEY})
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read())
    content = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
    print(f"DashScope 连通 OK: model={MODEL} reply={content!r}")
except Exception as e:
    print(f"FAIL: DashScope 不可用: {e}")
    sys.exit(1)

# 2) 写 LLM 配置
conf_path = r"E:\1AI\ComfyUI-aki-v3\ComfyUI\custom_nodes\ComfyUI-Anima-Batch-LoRA\data\llm_config.json"
os.makedirs(os.path.dirname(conf_path), exist_ok=True)
conf = {"mode": "api", "base_url": BASE, "api_key": KEY, "model": MODEL}
with open(conf_path, "w", encoding="utf-8") as f:
    json.dump(conf, f, ensure_ascii=False, indent=2)
print(f"配置已写入: {conf_path} (base={BASE}, model={MODEL}, key={'已写入' if KEY else '空'})")

# 3) 分类能力冒烟（模拟卡片分类请求格式）
payload2 = {
    "model": MODEL,
    "messages": [
        {"role": "system", "content": "你是提示词卡片分类助手。根据给定的分类列表，为每张卡片选择最合适的分类。严格只输出 JSON 数组（与输入行一一对应），每个元素是分类列表中的名称之一，不要输出任何其他内容。"},
        {"role": "user", "content": '分类列表：["通用", "角色", "画风", "姿势", "场景", "质量词", "LoRA 触发词"]\n\n卡片：\n1: skadi (arknights)\n2: masterpiece, best quality\n3: sitting on a chair'},
    ],
    "temperature": 0.1,
    "max_tokens": 120,
}
req2 = urllib.request.Request(BASE + "/chat/completions",
                              data=json.dumps(payload2).encode(),
                              headers={"Content-Type": "application/json",
                                       "Authorization": "Bearer " + KEY})
try:
    with urllib.request.urlopen(req2, timeout=60) as r:
        data2 = json.loads(r.read())
    c2 = (data2.get("choices") or [{}])[0].get("message", {}).get("content", "")
    print(f"分类冒烟 OK: {c2!r}")
except Exception as e:
    print(f"分类冒烟失败: {e}")
    sys.exit(1)