"""回归：Prompt 库首次初始化应创建“情绪 / 表情”分类及 10 组动作表情提示词。"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE = os.environ.get("TK_TEST_BASE_URL", "http://127.0.0.1:8188")
APP_URL = f"{BASE}/extensions/ComfyUI-Anima-Batch-LoRA/app/"
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")

EXPECTED = {
    "01_tsundere": ("She crosses her arms and turns her eyes away, puffing her cheeks with a small pout while a faint blush gives away her embarrassment.", ["crossed arms", "looking away", "pout", "puffy cheeks", "blush", "furrowed brows"]),
    "02_confused_tilt": ("She tilts her head slightly, raises one eyebrow, and touches her cheek with a finger as she looks genuinely puzzled.", ["head tilt", "raised eyebrow", "parted lips", "confused", "finger to cheek"]),
    "03_thinking": ("She brings a finger to her lips and raises her eyes thoughtfully, her brows slightly drawn together as she tries to figure something out.", ["thinking", "finger to mouth", "looking up", "closed mouth", "furrowed brows"]),
    "04_happy_fist_pump": ("She pumps one fist excitedly, breaking into a bright open-mouthed grin as her eyes light up with happiness.", ["fist pump", "clenched hand", "grin", "open mouth", "happy", "sparkling eyes"]),
    "05_gentle_care": ("She leans forward slightly with one hand resting against her chest, giving a gentle and caring smile as she watches with quiet concern.", ["hand on own chest", "leaning forward", "gentle smile", "concerned", "soft expression"]),
    "06_pleading": ("She reaches her hand out toward someone with a pleading look, her lips slightly parted and her eyes soft as if quietly asking for attention.", ["reaching out", "outstretched hand", "pleading", "blush", "parted lips", "teary eyes"]),
    "07_playful_tease": ("She sticks out her tongue, closes one eye, and flashes a playful V-sign with a mischievous grin.", ["tongue out", "one eye closed", "v", "grin", "playful"]),
    "08_shy_approach": ("She hides her hands behind her back and leans forward a little, smiling shyly with a warm blush as she waits for a response.", ["hands behind back", "leaning forward", "blush", "shy", "smile", "looking at viewer"]),
    "09_innocent_shrug": ("She gives a small shrug with both palms turned upward, tilting her head with raised eyebrows as if she has absolutely no idea what happened.", ["shrugging", "palms up", "head tilt", "confused", "open mouth", "raised eyebrows"]),
    "10_smug_idea": ("She raises one index finger as if she has just thought of a clever idea, wearing a confident little smirk with one eyebrow slightly raised.", ["index finger raised", "smug", "smirk", "closed mouth", "raised eyebrow"]),
}


def read_seeded_data(page):
    return page.evaluate(
        """
        async () => {
          const req = indexedDB.open('anima-lora');
          const database = await new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          const tx = database.transaction(['promptCategories', 'prompts'], 'readonly');
          const categories = await new Promise((resolve, reject) => {
            const r = tx.objectStore('promptCategories').getAll();
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
          });
          const prompts = await new Promise((resolve, reject) => {
            const r = tx.objectStore('prompts').getAll();
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
          });
          database.close();
          return { categories, prompts };
        }
        """
    )


def main() -> None:
    if not CHROME.exists():
        raise RuntimeError(f"未找到 Chrome: {CHROME}")
    with tempfile.TemporaryDirectory(prefix="tk-prompt-emotion-") as profile:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                profile,
                executable_path=str(CHROME),
                headless=True,
                viewport={"width": 1400, "height": 900},
                args=["--no-first-run", "--disable-gpu"],
            )
            page = context.pages[0] if context.pages else context.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(APP_URL, wait_until="domcontentloaded", timeout=30_000)
            page.wait_for_timeout(1_000)
            data = page.wait_for_function(
                """async () => {
                  const req = indexedDB.open('anima-lora');
                  return await new Promise(resolve => {
                    req.onsuccess = () => {
                      const db = req.result;
                      const tx = db.transaction(['promptCategories', 'prompts'], 'readonly');
                      const catReq = tx.objectStore('promptCategories').getAll();
                      const promptReq = tx.objectStore('prompts').getAll();
                      tx.oncomplete = () => { db.close(); resolve(catReq.result.some(c => c.name === '情绪 / 表情') && promptReq.result.filter(p => String(p.id).startsWith('prompt_emotion_')).length === 10); };
                      tx.onerror = () => resolve(false);
                    };
                    req.onerror = () => resolve(false);
                  });
                }""",
                timeout=10_000,
            )
            if not data:
                raise AssertionError("Prompt 库没有完成情绪种子初始化")
            seeded = read_seeded_data(page)
            category = next(c for c in seeded["categories"] if c["name"] == "情绪 / 表情")
            prompts = [p for p in seeded["prompts"] if str(p["id"]).startswith("prompt_emotion_")]
            if len(prompts) != 10 or any(p["categoryId"] != category["id"] for p in prompts):
                raise AssertionError({"category": category, "promptCount": len(prompts)})
            for prompt in prompts:
                suffix = str(prompt["id"])[len("prompt_emotion_"):]
                expected_prompt, expected_tags = EXPECTED[suffix]
                expected_combined = ", ".join(expected_tags) + "\n\n" + expected_prompt
                if prompt["prompt"] != expected_combined or prompt["notes"] != "" or prompt["tags"] != []:
                    raise AssertionError({"id": prompt["id"], "prompt": prompt["prompt"], "notes": prompt["notes"], "tags": prompt["tags"]})
            page.locator('.main-tab[data-section="prompt"]').click()
            page.wait_for_selector('.prompt-cat-item[data-catid="cat_emotion"]', timeout=5_000)
            page.locator('.prompt-cat-item[data-catid="cat_emotion"]').click()
            page.wait_for_function("document.querySelectorAll('#promptGrid .prompt-card').length === 10", timeout=5_000)
            if page.locator('#promptGrid .prompt-card').count() != 10:
                raise AssertionError("情绪 / 表情分类未在 Prompt 库显示 10 张卡片")

            # 模拟已经执行过 v2 的用户：旧记录把自然语言写入 prompt、Danbooru 提示词写入 tags；
            # 新版本应合并回 prompt，并写入 v3 标记。
            legacy = {
                f"prompt_emotion_{suffix}": {"prompt": prompt, "notes": "", "tags": tags}
                for suffix, (prompt, tags) in EXPECTED.items()
            }
            page.evaluate(
                """
                async (legacy) => {
                  const req = indexedDB.open('anima-lora');
                  const db = await new Promise((resolve, reject) => {
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                  });
                  await new Promise((resolve, reject) => {
                    const tx = db.transaction('prompts', 'readwrite');
                    const store = tx.objectStore('prompts');
                    for (const [id, patch] of Object.entries(legacy)) {
                      const get = store.get(id);
                      get.onsuccess = () => store.put({ ...get.result, ...patch });
                    }
                    tx.oncomplete = resolve;
                    tx.onerror = () => reject(tx.error);
                  });
                  await new Promise((resolve, reject) => {
                    const tx = db.transaction('prompts', 'readwrite');
                    tx.objectStore('prompts').delete('prompt_emotion_10_smug_idea');
                    tx.oncomplete = resolve;
                    tx.onerror = () => reject(tx.error);
                  });
                  db.close();
                  localStorage.removeItem('anima_prompt_emotion_seed_v3');
                  localStorage.setItem('anima_prompt_emotion_seed_v2', '1');
                }
                """,
                legacy,
            )
            page.reload(wait_until="domcontentloaded", timeout=30_000)
            page.wait_for_function(
                "() => localStorage.getItem('anima_prompt_emotion_seed_v3') === '1'",
                timeout=10_000,
            )
            repaired = read_seeded_data(page)
            repaired_prompts = [p for p in repaired["prompts"] if str(p["id"]).startswith("prompt_emotion_")]
            if any(str(p["id"]).endswith("10_smug_idea") for p in repaired_prompts):
                raise AssertionError("升级迁移不应恢复用户已删除的 v1 种子")
            for prompt in repaired_prompts:
                suffix = str(prompt["id"])[len("prompt_emotion_"):]
                expected_prompt, expected_tags = EXPECTED[suffix]
                expected_combined = ", ".join(expected_tags) + "\n\n" + expected_prompt
                if prompt["prompt"] != expected_combined or prompt["notes"] != "" or prompt["tags"] != []:
                    raise AssertionError({"id": prompt["id"], "prompt": prompt["prompt"], "notes": prompt["notes"], "tags": prompt["tags"]})
            if errors:
                raise AssertionError(f"页面 JS 异常: {errors[:5]}")
            print("PASS Prompt 库创建及 v2→v3 字段修复")
            context.close()


if __name__ == "__main__":
    main()
