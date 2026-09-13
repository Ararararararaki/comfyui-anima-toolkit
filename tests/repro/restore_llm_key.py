# -*- coding: utf-8 -*-
"""恢复 LLM 配置中的 api_key（从注册表读 DashScope key 写回配置文件）。"""
import json, os

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

conf_path = r"E:\1AI\ComfyUI-aki-v3\ComfyUI\custom_nodes\ComfyUI-Anima-Batch-LoRA\data\llm_config.json"
conf = json.load(open(conf_path, encoding="utf-8"))
key = get_env("DASHSCOPE_API_KEY") or ""
if key:
    conf["api_key"] = key
    json.dump(conf, open(conf_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("key restored:", bool(conf.get("api_key")))
else:
    print("FAIL: no key found in registry")