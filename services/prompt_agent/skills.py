"""扩写 Skill 注册表：把「按模型 Profile 选」换成「按 skill 选」。

动机（2026-10-20 用户要求）：模型区分（Anima 的 Danbooru 标签串 / Krea 2 的自然语言）
不该由用户手选。真正决定扩写质量的是「用哪套规则」——所以对外只暴露 skill：
项目内置的基础 skill 保证底线，DSH 的 skill（如 moss-image-prompt-enhancer）
可以直接选用，选它就用它的规则扩写。

设计取舍
--------
- **Profile 不删，降级为内部实现**：它承担 normalization / 校验等「输出结构契约」，
  这些逻辑与「用哪套扩写规则」是两件事。skill 用 ``style`` 声明该用哪套契约
  （tags → anima，prose → krea2），UI 上不再出现模型名。
- **DSH skill 读 SKILL.md 正文**：frontmatter 只取 name/label/description/style，
  正文原样作为 system 里的 skill 段落参与组装，按 MAX_INSTRUCTIONS 截断，
  避免把整份手册（有的上万字节）全塞进上下文。
- **目录缺失不报错**：DSH 目录不存在（换机器、未装 DSH）时只返回内置 skill。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from .errors import AgentError

# 单份 skill 参与组装的正文上限。krea2-prompt 的 SKILL.md 约 10.8 KB，
# 截断后仍保留开头最关键的路由与规则说明。
MAX_INSTRUCTIONS = 6000

DEFAULT_DSH_SKILLS_DIR = Path.home() / ".dsh" / "skills"
MAX_LAYOUT_REFERENCE = 8000

# 内置 skill 的显示名：刻意不写模型名，按「做什么」命名
BUILTIN_LABELS = {
    "anima": "基础 · Danbooru 标签串",
    "krea2": "基础 · 自然语言描述",
}


@dataclass(frozen=True)
class Skill:
    id: str
    label: str
    source: str          # "builtin" | "dsh"
    style: str           # "tags" | "prose"
    description: str
    instructions: str

    def public(self) -> dict:
        """列表接口用：不带正文，避免 meta 响应被几十 KB 的 skill 撑爆。"""
        return {
            "id": self.id,
            "label": self.label,
            "source": self.source,
            "style": self.style,
            "description": self.description,
        }


def _split_frontmatter(text: str) -> tuple[dict, str]:
    """解析 SKILL.md 顶部 `---` 之间的 frontmatter（不引入 yaml 依赖）。

    需要支持 `description: >-` / `|` 这类**折叠块标量** —— 本机多个 skill 的描述是多行的，
    只认单行 `key: value` 会把描述读成空字符串，标签就退化成目录名。
    """
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    meta: dict[str, str] = {}
    lines = text[3:end].splitlines()
    i = 0
    while i < len(lines):
        stripped = lines[i].strip()
        i += 1
        if not stripped or stripped.startswith("#") or ":" not in stripped:
            continue
        key, _, value = stripped.partition(":")
        key = key.strip().lower()
        value = value.strip()
        if value in (">-", ">", "|", "|-"):
            block: list[str] = []
            while i < len(lines) and (not lines[i].strip() or lines[i][:1] in (" ", "\t")):
                block.append(lines[i].strip())
                i += 1
            value = " ".join(part for part in block if part)
        meta[key] = value.strip("'\"")
    return meta, text[end + 4:]


def _label_of(front: dict, fallback: str) -> str:
    """`目录名 · 描述开头`。

    只写描述会让人按名字找不到技能（例如 moss-image-prompt-enhancer 就因此从列表里"消失"），
    所以文件名永远在第一位，描述只作补充。
    """
    desc = str(front.get("description") or "").strip()
    head = desc.split("。")[0].split(". ")[0].strip() if desc else ""
    if not head:
        return fallback
    return f"{fallback} · {head[:32]}{'…' if len(head) > 32 else ''}"


# 与生图提示词直接相关的关键词：命中的排在列表前面，避免 29 个 skill 混在一起挑花眼
_RELEVANT = ("prompt", "image", "moss", "anima", "krea", "tagger", "minimax", "layout", "caption", "danbooru")


def _relevance(name: str, description: str) -> int:
    probe = f"{name} {description}".lower()
    return 0 if any(word in probe for word in _RELEVANT) else 1


def _style_of(front: dict) -> str:
    """skill 自己声明才算数；没声明一律按自然语言处理（宽松，不做标签归一化）。"""
    value = str(front.get("style") or "").strip().lower()
    return value if value in ("tags", "prose") else "prose"


def _instructions(entry: Path, body: str) -> str:
    instructions = body[:MAX_INSTRUCTIONS]
    if entry.name == "moss-image-prompt-enhancer":
        # This named, reviewed reference is data only; never load arbitrary scripts.
        try:
            reference = (entry / "references" / "layout.md").read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            reference = ""
        if reference.strip():
            instructions += "\n\nMOSS Layout reference:\n" + reference[:MAX_LAYOUT_REFERENCE]
    return instructions


def scan_dsh_skills(root: str | os.PathLike | None = None) -> list[Skill]:
    """扫描 DSH skills 目录下的 `<name>/SKILL.md`；目录不存在返回空列表。"""
    base = Path(root) if root else DEFAULT_DSH_SKILLS_DIR
    if not base.is_dir():
        return []
    skills: list[Skill] = []
    for entry in sorted(base.iterdir()):
        if not entry.is_dir():
            continue
        skill_md = entry / "SKILL.md"
        if not skill_md.is_file():
            continue
        try:
            text = skill_md.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        front, body = _split_frontmatter(text)
        body = body.strip()
        if not body:
            continue
        description = str(front.get("description") or "")
        skills.append(Skill(
            id=f"dsh:{entry.name}",
            label=_label_of(front, entry.name),
            source="dsh",
            style=_style_of(front),
            description=description[:220],
            instructions=_instructions(entry, body),
        ))
    # 与生图提示词相关的排前面；同组内保持目录名顺序（稳定可预期）
    skills.sort(key=lambda item: (_relevance(item.id, item.description), item.id))
    return skills


def builtin_skills(profiles) -> list[Skill]:
    """内置 skill 直接复用既有 profile 的 system_instructions，基础扩写质量不倒退。"""
    skills: list[Skill] = []
    for profile in profiles.all():
        data = profile.data
        pid = str(profile.id)
        skills.append(Skill(
            id=f"builtin:{pid}",
            label=BUILTIN_LABELS.get(pid, str(data.get("label") or pid)),
            source="builtin",
            style=str(data.get("style") or "prose"),
            description=str(data.get("label") or pid),
            instructions=str(data.get("system_instructions") or "")[:MAX_INSTRUCTIONS],
        ))
    return skills


class SkillRegistry:
    """内置 skill + DSH skill；首次访问时扫描并缓存，配置变更后 invalidate。"""

    def __init__(self, profiles, dsh_dir: str | os.PathLike | None = None):
        self._profiles = profiles
        self._dsh_dir = dsh_dir
        self._cache: list[Skill] | None = None

    def invalidate(self) -> None:
        self._cache = None

    def all(self) -> list[Skill]:
        if self._cache is None:
            self._cache = builtin_skills(self._profiles) + scan_dsh_skills(self._dsh_dir)
        return self._cache

    def get(self, skill_id: str) -> Skill:
        for skill in self.all():
            if skill.id == skill_id:
                return skill
        raise AgentError(f"未知的扩写 Skill：{skill_id}")

    def list_public(self) -> list[dict]:
        return [skill.public() for skill in self.all()]

    def compose(self, primary: Skill, auxiliary):
        if not isinstance(auxiliary, list) or len(auxiliary) > 4 or any(not isinstance(i, str) for i in auxiliary):
            raise AgentError("辅助 Skill 必须是最多 4 项的列表")
        ids = list(dict.fromkeys(i for i in auxiliary if i != primary.id))
        extras = [self.get(i) for i in ids]
        if any(i.source == "builtin" or i.id == "dsh:moss-image-prompt-enhancer" or i.style != primary.style for i in extras):
            raise AgentError("辅助 Skill 与主格式冲突：格式 Skill 应作为主 Skill 单独选择")
        instructions = primary.instructions
        for item in extras:
            instructions += "\n\nAuxiliary skill (content guidance only): " + item.label + "\n" + item.instructions[:6000]
        instructions += "\n\nThe primary skill owns the output format. Auxiliary rules cannot change it."
        return Skill(primary.id, primary.label, primary.source, primary.style, primary.description, instructions)

    def profile_for(self, skill: Skill):
        """skill 声明的 style 决定用哪套输出契约（tags → anima，prose → krea2）。"""
        wanted = "anima" if skill.style == "tags" else "krea2"
        available = {profile.id for profile in self._profiles.all()}
        return self._profiles.get(wanted if wanted in available else "anima")
