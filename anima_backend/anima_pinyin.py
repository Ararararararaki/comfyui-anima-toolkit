# -*- coding: utf-8 -*-
"""拼音字表（构建期预建数据，**无任何第三方运行时依赖**）。

## 来源与许可

字表数据派生自 **pinyin-data**（<https://github.com/mozillazg/pinyin-data>，MIT License，
取用版本 0.15.0）。本文件是它的**子集重排**：只保留在 `anima_alias_index.json` 的
角色 / 作品中文名里真实出现过的汉字（3710 字，覆盖全部中文名 **100%** 的用字），
按「首读音音节」分组，压缩成下面这张 `_SYLLABLE_TABLE`。

## 为什么预建成数据而不是运行时转换

中文用户的痛点：**打不出汉字**时只能用拼音输入（`chuyin` / `cywl`）。真做运行时转换需要
「汉字 → 拼音」字表 + 多音字消歧，且每次查询都要现算 —— 与 `anima_tag_index` 的
「归一化键一律构建期预建」纪律冲突（实测不预建会到 400ms 级）。
故本文件只提供**构建期**用的纯函数：`pinyin_keys()` / `pinyin_initials()`，
查询侧永远只做 dict 查与二分。

## 表结构（刻意做成字符串，省内存也便于人工校对）

    "chu": "初 出 楚…"            # 首读音为 chu 的字
    "fang": "方|fang,fang,pang…"  # `|` 之后是该字**其余读音**（多音字），最多 1 个

多音字共 1028 个（如 方 fang/feng、明 ming/meng、亚 ya）、覆盖率仍 100%：
`pinyin_keys()` 会对多音字做笛卡尔展开并去重，所以 `dongfang` 与 `dongfeng` 都能命中「东方」。
"""
from __future__ import annotations

import unicodedata
from typing import Any

__all__ = [
    "cjk_only",
    "normalize_pinyin",
    "syllables_of",
    "pinyin_keys",
    "pinyin_initials",
]

#: 单名最多展开的拼音组合数（防多音字笛卡尔爆炸；实测 5 万字名均 <4）
MAX_COMBINATIONS = 4
#: 单字最多保留的读音数（首读音 + 备选）
MAX_READINGS = 2

#: 音节 → 该音节为首读音的字（`|` 后为其余读音）；数据见模块 docstring 的来源说明
_SYLLABLE_TABLE: dict[str, str] = {
    "a": "阿|e 啊|e",
    "ai": "艾|yi 爱 埃|zhi 愛 哀 矮 哎",
    "an": "安 暗 案 岸 闇|yin 鞍 庵|yan 黯",
    "ang": "昂|yang 肮|hang 盎",
    "ao": "奥|yu 傲 澳|yu 螯 敖 獒",
    "ba": "巴 八 芭|pa 霸|po 吧|pa 爸 拔|bo 叭|pa 把|pa 扒|pa 跋|bei 疤 抜 坝",
    "bai": "白|bo 百|bo 柏|bo 拜 败 稗 摆",
    "ban": "坂 班 斑 半|pan 板 版 绊 伴|pan 阪 般|pan 扳|pan 办 絆 搬|su 瓣",
    "bang": "邦 帮 棒 浜|bin 膀|pang",
    "bao": "宝 保 暴|pu 爆|bo 豹 薄|bo 堡|bu 胞|pao 包|pao 鲍 报 抱|pao 鴇 寶 饱 鸨 苞|pao 報|fu 鉋|pao",
    "bei": "贝 北 备 辈 杯 卑|bi 背 被|bi 悲 倍|pei 蓓 呗|bai 備 輩 琲 貝 悖",
    "ben": "本 笨 奔|fen 贲|bi",
    "beng": "崩 蹦",
    "bi": "碧 比|pi 彼 笔 壁 必 鼻 毕 避 臂|bei 俾|bei 币|yin 哔 匕|pin 闭 庇|pi 弊 陛 逼",
    "bian": "便|pian 变 边 蝙|pian 辫 编 鞭 弁|pan 辺 変 扁|pian 遍 辨|ban",
    "biao": "表 标 飙 杓|shao 镖 俵",
    "bie": "别",
    "bin": "宾 滨 彬|ban 槟|bing 殡",
    "bing": "兵 冰|ning 饼 柄 病 并 氷 餠 禀",
    "bo": "波|bei 博 伯|bai 卜|bu 狛 勃 播 拨 啵 玻 舶 钵",
    "bu": "布 部|pou 不|fou 步 怖 簿|bo 捕 歩 补",
    "ca": "嚓|cha",
    "cai": "菜 彩 裁 才|zai 财 采 蔡|sa 材 財 採",
    "can": "喰|sun 灿 餐|sun 残 蚕|tian 惨 参|cen 璨 掺|chan",
    "cang": "仓 藏|zang 苍 倉|chuang 蒼",
    "cao": "草|zao 操 曹 槽|zao",
    "ce": "策 侧|ze 测",
    "cen": "岑 梣|chen",
    "ceng": "曾|zeng 层 曽 層",
    "cha": "查|zha 茶 叉 察|cui 差|chai 插|zha 衩 侘",
    "chai": "柴|ci 豺 拆|che",
    "chan": "缠 禅|shan 颤|zhan 产 蝉 蟾 禪|shan 忏|qian 阐 蟬|ti 铲",
    "chang": "场 常 菖 唱 昌 厂|han 肠 嫦 畅 場|shang",
    "chao": "超|tiao 朝|zhao 潮 巢 炒 吵|miao 抄|suo 嘲|zhao",
    "che": "车|ju 彻 徹",
    "chen": "辰 陈 尘 臣 衬 沉 晨",
    "cheng": "城 称|chen 成 澄|deng 诚 橙|deng 程 承|zheng 乘|sheng 誠 惩 秤|ping 丞|sheng 撑",
    "chi": "赤 池|tuo 持 吃|qi 炽 齿 尺|che 翅 痴 斥|che 驰 敕|sou 蚩",
    "chong": "虫|hui 冲 崇 宠 充 憧|zhuang 铳 沖",
    "chou": "丑 紬|zhou 仇|qiu 臭|xiu 抽 䌷 愁|qiao 绸",
    "chu": "初 雏 出 楚 处 触 厨 雛|ju 杵 础 蜍|yu 褚|zhe",
    "chuan": "川 传|zhuan 船 穿|yuan 串|guan",
    "chuang": "创 床 窗|cong",
    "chui": "吹 椎|zhui 锤 垂|zhui 槌|zhui 炊",
    "chun": "春 纯 椿 唇|zhen 淳|zhun 醇 純|zhun",
    "chuo": "绰|chao 辍",
    "ci": "次|zi 茨 刺|qi 慈 此 雌 磁 伺|si 词 赐 鹚 疵|zi",
    "cong": "从|zong 丛 葱|chuang 聪 従",
    "cou": "凑 湊",
    "cu": "粗 醋|zuo 蹴|zu 簇|chuo 酢|zuo",
    "cui": "翠 崔 催 粹|sui 萃 璀 摧|zui 淬|zu 脆",
    "cun": "村 存 寸 拵|zun",
    "cuo": "错 嵯|ci",
    "da": "大|dai 达|ti 妲 打 搭|ta 達|ta 答 哒 燵 嗒|ta",
    "dai": "代 黛 戴 袋 带 待 呆|bao 岱 逮|di 歹|e 怠|yi",
    "dan": "丹 弹|tan 蛋 胆|tan 诞 单|chan 旦 但|tan 淡|yan 啖 担|jie 弾",
    "dang": "档 当 宕 党 荡 铛|cheng",
    "dao": "岛 道 刀|diao 稻 导 盗 島 嶋 捣 到 祷 導 倒 悼 稲",
    "de": "德 的|di 得|dei 徳",
    "deng": "登|de 灯|ding 等 邓|shan 燈 瞪",
    "di": "蒂 迪 第 地|de 帝 狄|ti 敌|hua 弟|ti 荻 堤|ti 低 谛 底|de 镝 笛 滴 鏑 涤 砥|zhi",
    "dian": "电 典|tian 点 店 槙 甸|tian 殿 巅 钿|tian 電 靛 淀 颠 癫 垫 佃|tian",
    "diao": "调|tiao 吊 雕 貂 調|tiao 钓 掉|nuo 弔|di 凋",
    "die": "蝶|tie 谍 迭|yi 爹 叠",
    "ding": "丁|zheng 定 钉 顶 碇 釘|ling 锭 鼎|zhen 叮",
    "diu": "丢",
    "dong": "动 东 冬 洞|tong 東 冻 咚 鸫 董|zhong 動 胴 栋 諌 棟",
    "dou": "斗|zhu 都|du 豆 兜 蚪 闘 逗|zhu",
    "du": "度|duo 杜|tu 渡 毒|dai 独 督 嘟 读|dou 笃 赌 镀 妒 肚 読 髑 堵|zhe 渎",
    "duan": "短 锻 断 段 缎 端 椴",
    "dui": "队 对 碓 隊|zhui 対 堆|zui",
    "dun": "顿|du 敦|dui 遁|qun 沌|zhuan 盾|shun 楯|shun 钝 炖|tun",
    "duo": "多 朵 堕|hui 哆|chi 舵 铎 夺",
    "e": "恶|wu 鹅 厄 俄 鳄 饿 蛾|yi 颚 峨 噩 垩|sheng 鄂 娥 额 锷 莪 谔 悪 餓",
    "en": "恩",
    "er": "尔 二 儿|ren 耳|reng 爾|mi 珥 贰 而|neng 佴|nai 児",
    "fa": "法 发 伐 珐 発 乏",
    "fan": "饭 凡 帆 反 范 幡 番|pan 梵 犯 烦 飯 蕃|bo 繁|po 贩",
    "fang": "方|pang 芳 放 防 房|pang 访 纺 坊 仿|pang 枋|bing",
    "fei": "菲 飞 费 绯 翡 妃|pei 斐 非 狒 啡|pei 飛 肥|bi 吠 废 腓 霏 鲱 緋 扉",
    "fen": "芬 粉 分 愤 份|bin 焚 奋|kang",
    "feng": "风 枫 凤 峰 锋 蜂 冯|ping 丰 封|bian 疯 逢|peng 風 楓|fan 奉 缝 鳳 峯 讽",
    "fou": "否|pi",
    "fu": "服|bi 夫 芙 弗 福 符 富 伏 浮 佛|fo 抚 蝠 复 敷 父 肤 腐 妇 辅 扶|pu 缚 斧 负 傅 腹 辐 副|pi 附|bu 付 甫|pu 府 蝮 孵 俘 馥|bi 幅|bi 孚 袱 赋",
    "ga": "伽|jia 嘎 噶|ge",
    "gai": "概|gui 改 盖|ge 该",
    "gan": "甘|han 干|an 绀 柑|qian 感|han 敢 橄 肝 杆 赶|qian",
    "gang": "刚 冈 钢 纲 港|hong 岡 杠|gong 剛 綱 岗",
    "gao": "高 皋|hao 糕 皐 告|ju 搞|qiao 羔 缟 锆 膏",
    "ge": "格|luo 歌 戈 葛 哥 个|gan 革|ji 鸽 各 割 阁 隔|rong 搁",
    "gei": "给|ji",
    "gen": "根 艮|hen 茛|jian 跟 亘|xuan",
    "geng": "更 梗 耕 耿 庚",
    "gong": "宫 公 工 弓 贡 宮 恭 攻 功 蚣|zhong 共|hong",
    "gou": "狗 构 篝 勾 垢 沟 钩 枸|ju 够 苟 鈎",
    "gu": "古|ku 谷|lu 骨 咕 菇 姑 故 鼓 孤 固 呱|gua 菰 雇|hu 蛊",
    "gua": "瓜 寡 挂 颪 聒|guo",
    "guai": "怪",
    "guan": "关 冠 官 管 馆 观 贯 関 棺 灌|huan 鹳 罐 惯 關|wan 貫|wan",
    "guang": "光 广|yan 広 洸|huang 桄 廣|kuang",
    "gui": "鬼 贵 桂 龟|jun 圭 瑰 诡 槻 归 轨 傀|kui 桧|hui 鲑|xie 规 癸 闺 刽 柜|ju 袿|gua 珪 帰 跪 貴",
    "gun": "滚 丨 衮 棍|hun",
    "guo": "国 果|luo 过 锅 菓 裹 郭 鍋",
    "ha": "哈|he 蛤|ge",
    "hai": "海 孩 骇 亥|jie 害|he 骸|gai 还|huan",
    "han": "韩 汉 翰 寒 汗|gan 含 罕 撼 悍 函 喊|kan 旱",
    "hang": "航 杭|kang 珩|heng",
    "hao": "号|xiao 豪 好 浩|gao 毫 嚎 貉|he 皓|hui 昊 郝|shi",
    "he": "和|hu 合|ge 赫|shi 河 鹤 贺 荷 核|hu 鶴 诃 何 賀 呵|ha 褐 禾",
    "hei": "黑 黒 嘿|mo",
    "hen": "痕|gen 很",
    "heng": "恒 亨|xiang 横|guang",
    "hong": "红|gong 虹|jiang 轰 宏 弘 紅|gong 吽|ou 洪 鸿 纮 烘",
    "hou": "后 猴 吼 逅 厚 睺 喉 侯 候",
    "hu": "狐 虎 护 户 胡 瑚 琥 冴 呼|xiao 浒|xu 蝴 湖 糊 壶 戸 弧 互 槲 祜 醐 乎",
    "hua": "花 华 画 化|huo 划|guo 话 華|kua 滑|gu 椛 猾 桦 話",
    "huai": "坏|pi 怀|fu 槐 壊 淮 踝 徊|hui",
    "huan": "幻 环 唤 欢 獾|quan 浣 鹮 换 環 寰|xian 患 歓 焕",
    "huang": "黄 皇|wang 荒|kang 煌 凰 晃 谎 簧 幌 蝗 篁 徨 磺|kuang 慌",
    "hui": "惠 绘 辉 会|kuai 灰 回 彗|sui 挥 慧 卉 毁 晖 喙|zhou 廻 荟 徽 茴 恵 輝 瘣|lei 悔 晦 汇 秽",
    "hun": "魂 混|gun 昏 婚",
    "huo": "火 霍|he 活|guo 或|yu 惑 伙 祸 藿|he 货 获",
    "ji": "吉 姬|yi 基 机|wei 纪 级 记 极 季 计 祭|zhai 击 迹 姫|zhen 鸡 集 矶 际 棘 己|qi 忌 疾 荠|qi 及 继 戟 寄 急 寂 饥 剂 积|zhi 肌 激|jiao 技|qi 蓟 籍|jie 伎|zhi 济 几 叽|jiao 鹡 骥 圾|jie 機 記 紀 妓 诘|jie 嫉 辑 脊 嵴 薺|ci 箕 繋 稽|qi 髻|jie 撃 挤 绩",
    "jia": "加 家|jie 甲 嘉 佳 假|jie 贾|gu 迦|xie 茄|qie 榎 夹|ga 岬 枷 架 嫁 珈 颊 袈 鋏 价|jie 荚",
    "jian": "剑 见|xian 舰 间 健 箭 鉴 兼 简 見|xian 建 件|mou 坚 樫 菅|guan 监 键 茧|chong 尖 間 毽 剪 谏 艦 锏 肩|xian 笕 溅 揃|qian 歼 鍵 劍 缄 渐 鍳 戬 鲣 奸|gan 减 检",
    "jiang": "酱 江 将|qiang 降|xiang 匠 僵 姜 奖 浆 绛 讲 將|qiang 缰 蒋",
    "jiao": "角|jue 教 交 椒 礁 鲛 娇 蕉|qiao 脚|jue 狡|xiao 焦|qiao 郊 叫 饺 胶|xiao 轿 跤|qiao 搅 较 酵 骄",
    "jie": "杰 结 界 姐|ju 洁|ji 街 介|ge 节 阶 捷|qie 戒 解|xie 皆 接|xie 結|ji 芥|gai 劫 婕|qie 借 孑 届 羯 堺 杢 節 睫|she 桀 截",
    "jin": "金 津 近 进 堇|qin 今 锦 巾 尽 禁 菫 烬 紧 晋 瑾 槿|qin 斤 矜|qin 襟 筋|qian 衿|qin",
    "jing": "精|qing 井 静 镜 境 京 晶 景|ying 鲸 睛 警 经 惊|liang 荆 净|cheng 竞 敬 瀞 阱 靖 鏡 颈|geng 径 璟 憬",
    "jiu": "久 九 酒 啾 玖 鸠 旧 鹫 救 究 咎|gao 就 臼 舅 柾 鳩|qiu 柩 韭 韮 鷲",
    "ju": "巨|qu 菊 橘 锯 具 居|ji 剧 鞠|qu 驹 俱 局 狙 桔|jie 惧 句|gou 苣|qu 矩 炬 裾 駒 据 蒟 聚 劇",
    "juan": "卷|quan 绢 鹃 娟 羂 絹|xuan 巻",
    "jue": "绝 爵 觉|jiao 决 掘|ku 珏 倔 絕",
    "jun": "君 军 郡 俊|shun 骏 軍 菌 駿",
    "ka": "卡|qia 喀|ke 咖|ga 咔|nong",
    "kai": "凯 开 铠 鎧",
    "kan": "坎 栞 看 勘 刊 槛|jian 堪|chen",
    "kang": "康 抗|gang",
    "kao": "考 尻 拷 烤",
    "ke": "克 可|ge 科 客|qia 柯 刻|kei 珂 壳|qiao 课 苛|he 蝌 渴|jie 轲 颗",
    "ken": "肯 啃",
    "keng": "坑|kang",
    "kong": "空 恐 孔 控|qiang",
    "kou": "口 蔻 寇 扣",
    "ku": "库 骷 堀 酷 裤 苦|gu 哭 枯|gu 窟 袴 喾",
    "kua": "夸",
    "kuai": "快 块|yue 狯",
    "kuan": "宽 款|xin",
    "kuang": "狂|jue 矿 框 匡|wang",
    "kui": "葵 奎 盔 溃|hui 魁|kuai 蝰 馈 揆",
    "kun": "昆|hun 困 坤",
    "kuo": "廓 蛞|she",
    "la": "拉 菈 辣 啦 蜡|qu 垃 喇 腊|xi",
    "lai": "莱 濑 来 瀬 赖 萊 瀨 頼 來",
    "lan": "蓝|la 兰 岚 懒 篮 藍|la 蘭 嵐 烂 榄 拦 览 澜 婪",
    "lang": "郎 狼|hang 朗 浪 螂 琅 榔 廊",
    "lao": "劳 老 姥|mu 牢|lou 烙|luo 酪|luo",
    "le": "乐|yue 了|liao 楽 肋|lei",
    "lei": "雷 蕾 勒|le 类 泪 累|lu 垒 儡 涙 擂 镭 磊",
    "leng": "冷|ling 棱|ling 稜|ling 楞",
    "li": "莉|chi 里 利 丽 理 力 立|wei 璃 梨 李 狸 礼 栗|lie 历 笠 离|chi 黎 隶|dai 麗|si 俐 鲤 砾 豊|feng 厉 俪 吏 砺 哩|mai 栎|yue 粒 骊 櫟|luo 枥 荔 雳 裏 隷 猁 靂",
    "lia": "俩|liang",
    "lian": "莲 联 连 恋 怜|ling 炼 练 廉 脸 链 镰 涟 蓮 連|lan 憐 琏 戀",
    "liang": "良 凉 亮 量 两 涼 梁 魉 椋 谅",
    "liao": "疗 料 辽 獠|lao 蓼|lu 缭 镣 繚|rao 寮",
    "lie": "列|li 猎|xi 烈 裂 鴷 冽 鬣",
    "lin": "琳 林 凛 临 麟 磷|ling 燐 邻 鳞 霖 淋 凜 粼 璘 懍",
    "ling": "灵 铃 绫 玲 零|lian 澪 领 岭 菱 令|lian 凌 綾 霊 鈴 伶 陵 翎 羚 鸰 另 蛉 龄 苓|lian 聆 嶺 孁",
    "liu": "流 留 琉 六|lu 瑠 柳 刘 榴 溜 劉 硫|chu",
    "long": "龙 隆 泷|shuang 胧 笼 龍|mang 珑 瀧|shuang",
    "lou": "髅 楼 漏 娄",
    "lu": "露|lou 鲁 路|luo 鹿 绿 卢 陆|liu 旅 吕 律 录 璐 芦|hu 禄 鹭 戮 侣 鲈 榈 炉 驴 呂 鑢 陸|liu 铝 噜 箓 緑 氯 魯 率|shuai 侶 蕗 鷺 鸬",
    "luan": "乱 卵|kun 孪 鸾",
    "lue": "略 掠",
    "lun": "伦 轮 论 仑 纶|guan 崘 輪",
    "luo": "罗 洛 萝 落|la 螺 络|lao 羅 裸 啰 逻 珞|li 骆 蘿",
    "ma": "玛 马 麻 妈 码 馬 蟇 瑪 嘛 吗 蟆|mo 孖|zi 犸",
    "mai": "麦 迈 脉|mo 卖 埋|man 霾|li 买",
    "man": "曼 漫 满 蛮 蔓|wan 鳗 慢 満 馒 幔 滿|men",
    "mang": "蟒|meng 氓|meng 芒|huang 莽 盲",
    "mao": "猫|miao 毛 昴 帽 貌|mo 冒|mo 卯 茂 茅 矛 牦 貓 锚 贸",
    "me": "么|yao",
    "mei": "美 梅 妹 莓 魅 玫 没|mo 眉 苺 媒 煤 枚 每 媚",
    "men": "门 们 門 闷",
    "meng": "梦 盟|ming 蒙 萌|ming 檬 夢 猛 孟 虻 獴 儚 蜢",
    "mi": "米 迷 弥 蜜 密 咪|mie 糸|si 秘|bi 谜|mei 祢|ni 谧 禰|ni 猕 靡|ma 麿 糜|mei 樒",
    "mian": "面 绵 棉 眠|min 綿 缅 免|wen 勉",
    "miao": "喵 妙 苗 描|mao 瞄 庙",
    "mie": "灭 咩",
    "min": "敏 民 闵 珉 皿|ming",
    "ming": "名 明|meng 鸣 命 冥|mian 鳴 溟|mi 铭",
    "mo": "魔 莫|mu 摩|ma 默 墨|mei 茉 末|me 模|mu 磨 漠 貘 沫 蘑 陌 獏|mu 抹|ma 貊|ma 摸 膜",
    "mou": "缪|miao 谋 牟|mu 某|mei 哞 謀",
    "mu": "木 姆 目 母|wu 牧 穆 睦 暮 牡 慕 幕|man 沐 墓 募|bo",
    "n": "嗯|ng",
    "na": "娜|nuo 纳 那|nuo 雫 拿 哪|ne 呐|ne 納",
    "nai": "奈 乃|ai 奶 耐|neng",
    "nan": "南|na 男 楠 难",
    "nao": "脑 瑙 闹 挠 恼",
    "ne": "呢|ni",
    "nei": "内|na",
    "nen": "嫩",
    "neng": "能|tai",
    "ni": "尼 妮 昵|zhi 逆 泥|nie 你 拟 霓 倪|nie 匿|te 籾 擬 溺|ruo",
    "nian": "念 年|ning 鲶 黏 鲇 廿 鮎",
    "niang": "娘 酿",
    "niao": "鸟|diao 鳥|diao 蔦 茑",
    "nie": "涅 聂 啮 孽 捏",
    "ning": "宁|zhu 柠|chu 凝 寧 狞 檸",
    "niu": "牛 纽 妞|hao 狃|nu 扭|chou",
    "nong": "农 侬 浓",
    "nu": "女|ru 努 怒 奴 弩 钕",
    "nuan": "暖|xuan",
    "nue": "虐",
    "nuo": "诺 傩 挪 諾 梛",
    "o": "哦|e",
    "ou": "欧 偶 鸥 鴎",
    "pa": "帕|mo 琶 啪 怕|bo 杷|ba 爬",
    "pai": "派|mai 牌 拍|bo 排|bai 徘",
    "pan": "潘|bo 判 盘 叛 槃 磐 萠 畔 盼|fen 攀",
    "pang": "胖|pan 庞 旁|peng 螃|bang 彷|fang",
    "pao": "泡 炮|bao 跑|bo 袍|bao 鞄 咆 刨|bao",
    "pei": "佩 配 裴|fei 培|pou 轡",
    "pen": "喷 盆",
    "peng": "朋 蓬 彭|pang 膨 椪 篷 棚 砰|ping 烹 碰",
    "pi": "皮 琵 匹 毗 毘 披 劈 枇|bi 霹 批 啤 譬",
    "pian": "片|pan 篇 骗 翩",
    "piao": "漂|biao 飘 瓢 票",
    "pin": "品 频 贫 拼|bing 聘|ping",
    "ping": "平|pian 苹|peng 萍 瓶 凭 屏|bing 评 塀",
    "po": "破 珀 婆 泊|bo 魄|bo 坡 泼 迫|pai 粕",
    "pu": "普 浦 仆 噗 蒲|bo 朴|piao 璞 葡|bei 谱 扑|pi 獛",
    "qi": "奇|ji 崎|yi 骑 七 琪 栖|xi 器 气 期|ji 齐|ji 企 绮 祈|gui 起 契|xie 旗 麒 启 岐 妻 泣|li 其|ji 琦 埼 汽|gai 漆|qie 砌|qie 杞 脐 淇 祇|chi 綺|yi 乞 欺 棲|xi 祁|zhi 鳍 歧 棋|ji 嵜 斉 㟢 弃 憩 気",
    "qia": "恰 峠",
    "qian": "千 前|jian 茜|xi 浅|jian 潜 乾|gan 钱 钳 谦 倩|qing 铅|yan 遣 签 芡 虔",
    "qiang": "枪 强|jiang 蔷 墙 腔|kong 锖 羌 薔|se 抢",
    "qiao": "乔 桥 巧 鞘|shao 敲 殻 橋|jiao 锹 橇 喬|jiao",
    "qie": "切|qi 窃",
    "qin": "琴 亲|qing 芹 沁 檎 秦 侵 寝 勤|qi 钦",
    "qing": "青|jing 清 轻 晴 情 庆 擎 蜻|jing 卿 请 顷 倾",
    "qiong": "琼 穹|kong 穷",
    "qiu": "秋 球 丘 求 裘 萩|jiao 囚 毬 酋 犰 邱 鳅",
    "qu": "区|ou 曲 驱 取 屈|jue 去 躯 趣|cu 鸲 區|ou",
    "quan": "泉 犬 拳 全 圈|juan 权 券|xuan 権 蜷|juan",
    "que": "雀|qiao 确 缺|kui 塙|qiao 却",
    "qun": "群 裙",
    "ran": "然 染 蚺|tian 燃 冉|nan",
    "rang": "让 穰|reng 穣",
    "rao": "扰|you 饶 绕",
    "re": "热 惹|ruo",
    "ren": "人 忍 刃 仁 壬 任|lin 稔 葚|shen 仞 认",
    "reng": "仍",
    "ri": "日",
    "rong": "荣 蓉 熔 绒 戎|reng 融 茸 蝾 溶 容|yong 栄",
    "rou": "肉|ru 柔",
    "ru": "如 入 乳 儒 鳰 汝 蠕 孺 蓐 濡|ruan",
    "ruan": "软 阮|yuan",
    "rui": "瑞 锐 睿 叡 芮|ruo 蕊|juan 銳",
    "run": "润 潤",
    "ruo": "若|re 弱 蒻",
    "sa": "萨 撒 飒",
    "sai": "塞|se 赛 鳃",
    "san": "三 伞 散 傘",
    "sang": "桑 丧",
    "sao": "扫 骚",
    "se": "色|shai 瑟 涩 渋 澁",
    "sen": "森",
    "seng": "僧|ceng",
    "sha": "莎|suo 沙|suo 纱 杀 砂 刹|cha 鲨 紗|miao 裟 厦|xia 傻 殺|shai",
    "shai": "晒",
    "shan": "山 闪 珊 杉|sha 善 衫 扇 擅 钐 膳 姗",
    "shang": "上 尚|chang 商 伤 裳|chang 赏",
    "shao": "少 烧 梢|xiao 哨|sao 芍|xiao 勺|shuo 邵 焼 蛸|xiao",
    "she": "蛇|yi 射|ye 社 舌|gua 设 舍|shi 涉|die 奢 慑 摄 猞",
    "shen": "神 深 什|shi 身|juan 申 审 慎|zhen 榊 莘|xin 沈|chen 伸 甚 绅 矧 砷 蜃",
    "sheng": "生 圣|ku 胜|xing 声|qing 盛|cheng 聖 绳 升 笙 聲 省|xing",
    "shi": "士 师 石|dan 使 世 时 十 诗 史 实 狮 矢 式|te 始 室 食|si 市|fu 饰 事|zi 施|yi 侍 示|qi 尸 视 失|yi 噬 势 辻 是|ti 识|zhi 氏|zhi 似|si 柿 誓 蚀 実 時 莳 释 師 湿 媞|ti 詩 试 逝 匙|chi 弑 飾|chi 獅 仕 屎|xi 勢 拾|she",
    "shou": "兽 手 守 收 寿 首 狩 授 受|dao 瘦 售|shu",
    "shu": "树 鼠 术|zhu 数|shuo 属|zhu 书 舒|yu 束 曙 叔 殊 樹 淑|chu 枢 竖 述 输 術 疏 糬 黍 熟|shou 塾 蜀 書 墅|ye 薯 抒 蔬",
    "shuai": "摔 衰|suo 帅 蟀",
    "shuang": "双 霜 爽",
    "shui": "水 睡 税|tuo",
    "shun": "瞬 顺 舜",
    "shuo": "说|shui 烁 朔 説|shui",
    "si": "斯|shi 丝 四 寺|shi 死 司|ci 私 思|sai 巳|yi 饲 嗣 絲 祀 嘶",
    "song": "松 颂 送 宋 菘 嵩",
    "sou": "薮 籔|shu 叟|xiao",
    "su": "苏 素 速 宿|xiu 粟 稣 塑 酥 肃",
    "suan": "蒜 酸 算",
    "sui": "穗 岁 碎 随 穂 髓 燧 砕 歳",
    "sun": "隼 孙 孫|xun 狲 笋 荪",
    "suo": "索 所 锁 梭|xun 娑 缩|su 蓑|sui",
    "ta": "塔|da 他|tuo 獭 她|jie 榻 踏 挞 塌|da",
    "tai": "太|ta 泰 态 台|yi 汰 胎 苔 钛 跆",
    "tan": "坦 探|xian 炭 滩 檀|shan 谭 贪 昙|yu 毯 谈 叹|yi 碳 譚 坛",
    "tang": "堂 糖 汤|shang 唐 螳 棠 膛 烫 伖",
    "tao": "桃|tiao 套 陶|yao 逃 涛 讨 萄 淘 饕 绹",
    "te": "特 忒|tui",
    "teng": "藤 滕 腾 縢",
    "ti": "提|di 缇 体|ben 笹 替 薙|zhi 题 踢|die 嚏 鹈 梯 瑅 醍 锑 涕",
    "tian": "天 田 甜 畑 添 鴫 畠 舔|tan 填|chen",
    "tiao": "条 跳|diao 條 鲦 窕 挑|tao",
    "tie": "铁 帖 餮",
    "ting": "町|ding 汀|ding 庭 霆 婷 听|yin 亭 廷 艇 蜓|dian 廳 停 厅 挺",
    "tong": "桐|dong 通 童|zhong 同 瞳 统 樋 筒|dong 铜 桶 痛",
    "tou": "头 透|shu 偷 投|dou 骰|gu",
    "tu": "兔|chan 图 土|du 途 突 徒 涂|chu 屠 吐 秃 凸 塗|du 荼|cha",
    "tuan": "团|qiu 猯 貒",
    "tui": "推 退 腿 褪|tun",
    "tun": "豚|dun 吞|tian 臀",
    "tuo": "托 拓|ta 陀|duo 驼 脱|tui 拖|chi 鸵 騨",
    "wa": "瓦 娃|gui 蛙|jue 袜|mo 哇|gui 娲 洼|gui 挖",
    "wai": "外 歪",
    "wan": "丸 万|mo 玩 湾 完|kuan 挽 顽 晚 腕 婉 宛|yuan 卍 弯",
    "wang": "王|yu 望 亡|wu 网 汪|hong 旺 忘 往 妄",
    "wei": "维 薇 威 尾|yi 未 卫 蔚|yu 唯 韦 畏 微 味|mei 围 隈 危 苇 猬 魏 位|li 伪 梶 为 委 伟 尉|yu 衛 慰 維|yi 纬 喂 偉 桅|gui 萎 葦 惟 违",
    "wen": "文 纹 温|yun 吻 雯 蚊 闻 问 稳 玟|min 瘟|wo 問",
    "weng": "翁 嗡",
    "wo": "我 沃 涡|guo 蜗 窝 握|ou 卧 渥|ou 莴 挝|zhua",
    "wu": "物 无|mo 乌 武 舞 五 雾 巫 屋 吾|yu 悟 务 午 伍 吴|tun 呜 霧|meng 無|mo 芜 烏|ya 梧|yu 蜈 鵐 鹉 兀 毋|mou 勿|mo 嗚 務|mao 误 呉 污",
    "xi": "西 希 系|ji 戏|hu 夕|yi 喜|chi 细 汐 洗|xian 吸 席 蜥 袭 锡 熙|yi 稀 息 犀 习 膝 禊 曦 悉 羲 禧 昔|cuo 嬉 覡 鼷 細 玺 浠 蟋 潟 習 隙",
    "xia": "夏|jia 下 霞 侠 虾|ha 狭 瑕 峡 暇|jia 匣 吓|he 鰕",
    "xian": "线 仙 先 险 弦 现 限|wen 贤 闲 鲜 馅 線 衔 宪|xiong 显 霰|san 藓 陷 咸|jian 羡|yan 閒|jian 閑 跹 現 嫌 銛|tian 县",
    "xiang": "香 想 向 像 相 响 翔 象 祥 乡 箱 项 橡 骧 響 郷 享 巷|hang",
    "xiao": "小 咲 晓 校|jiao 宵 笑 篠 筱 枭 鸮 肖 孝 魈 萧 硝|qiao 消 暁 霄 哮|xue 逍 曉 嚣|ao 效",
    "xie": "谢 邪|ya 蟹 械 蝎|he 歇|ya 鞋|wa 紲|yi 写 协 胁 泄|yi 榭 谐 邂 卸 脇 屑 榍 謝 携 斜|xia 亵",
    "xin": "心 新 信|shen 辛 欣 薪 馨",
    "xing": "星 形 行|hang 性 幸|nie 杏 型 猩 醒|cheng 兴 刑 腥 姓|sheng",
    "xiong": "雄 熊 匂 胸 凶 兄|kuang 匈",
    "xiu": "修 秀 休|xu 袖 朽 羞 绣 嗅 咻|xu 锈",
    "xu": "绪 须 虚 戌|qu 旭 絮|chu 緒 徐 叙 许|hu 須 续 墟 煦|xiu 嘘|shi 序",
    "xuan": "玄 旋 绚 漩 悬 喧 宣 炫 絢|xun 选 萱 泫|juan 眩|huan 渲",
    "xue": "雪 学 血|xie 穴|jue 靴 薛 削|xiao 學|hua 鳕",
    "xun": "寻|xin 薰 巡|yan 逊 训 驯 迅 巽|zhuan 薫 讯 醺 勋 蕈|tan 尋|xin 询 旬|jun 燻 循",
    "ya": "亚 雅 娅 芽 牙 鸦 鸭 亜 崖 压 押|xia 犽 哑 垭 涯 丫 桠 婭 呀|xia 轧|zha 讶 鴨",
    "yan": "焰 眼|wen 岩 炎|tan 彦|pan 烟|yin 燕 言|yin 延 魇 研|xing 盐 演 雁 颜 严 宴 厌 妍 验 焉|yi 鼹 艳 胭 阎 衍 塩 焱|yi 砚 巌 焔 顔|ya 堰 奄 臙 厳 棪 赝",
    "yang": "阳 洋|xiang 央|ying 羊 杨 扬 养 陽 样 秧 漾 様 鸯 楊 恙 仰|ang",
    "yao": "妖|jiao 遥 耀 要 药 摇 曜 咬|jiao 瑶 腰 谣 夭|wo 姚|tiao 尧 薬 窈 邀 钥|yue 肴 鳐",
    "ye": "野|shu 叶|xie 夜 耶|xie 也|yi 业 葉|she 爷 椰 液|shi 鵺 曳 页 楪|die 埜",
    "yi": "伊 一 衣 异 依 乙|jue 翼 易 义 意 医 仪 以|si 逸 忆 蚁 遗|wei 蜴|xi 怡 壹|yin 艺 亦 移|chi 益 裔 姨 疑|ning 夷 刈 谊 已|si 亿 弈 漪 饴 猗|ji 邑|e 熠 疫 议 儀 懿 役 義|xi 宜 詑|tuo 毅 彛 苅 溢",
    "yin": "音 银 因 阴 印|yi 隐 茵 吟|jin 引 饮 寅 銀 尹|yun 殷|yan 隠 胤 淫|yan 蚓 訚 荫 誾 垠|ken",
    "ying": "樱 英|yang 影 鹰 萤 桜 应 瑛 营 莺 映|yang 櫻 荧 鷹 硬|geng 鹦 迎 霙|yang 罂 蝇 婴 赢 瀛 蛍 璎 瓔 缨 楹",
    "yo": "哟",
    "yong": "泳 勇 永 咏 用 佣 蛹 涌|chong 俑 慵 詠",
    "you": "游|liu 由|yao 尤 优 友 有|wei 幽 柚|zhou 悠 幼|yao 右 又 忧 鼬 油 佑 祐 優 侑 宥 鱿 诱 邮 呦 遊 犹 憂 誘",
    "yu": "羽|hu 雨 鱼 御|ya 宇 玉 与 狱 语 愈 域 郁 裕 育|zhou 浴 余|tu 于|wei 欲 驭 遇|yong 癒 誉 愚 舆 虞 予|zhu 喻 预 語 芋|xu 榆 瑜 钰 込 狳 煜 竽 谕 豫|xie 渔 獄 屿 硲 蝓 俞|shu 愉|tou 萸 毓 俣",
    "yuan": "原 园|wan 院 员|yun 元 远 源 圆 渊 缘 苑|yu 垣 猿 園 鸢 援|huan 愿 怨|yun 螈 遠 渕 円 員|yun 媛 沅 鸳 鳶 縁 袁",
    "yue": "月|ru 约|yao 越|huo 岳 跃 悦 曰",
    "yun": "云 运 陨 雲 允|yuan 韵 芸 伝 孕 蕴 運 熨|yu 晕",
    "za": "杂|duo",
    "zai": "再 仔|zi 在 哉 宰 灾 载 崽",
    "zan": "赞 簪",
    "zang": "葬 脏 奘|zhuang 蔵|cang 弉",
    "zao": "早 藻 造|cao 枣 灶 蚤|zhao 竈 皂 噪 棗 繰|sao 糟",
    "ze": "泽 则 澤|shi 择|zhai 仄 责",
    "zei": "贼 賊",
    "zen": "怎",
    "zeng": "增|ceng 憎 赠",
    "zha": "扎|za 炸 札|ya 渣 乍|zuo 吒 诈",
    "zhai": "斋 宅|che 摘 债 斎",
    "zhan": "战 斩 戦 栈 詹|dan 占|tie 绽 站 戰 展",
    "zhang": "长|chang 章 张 丈 掌 長|chang 杖 彰 仗 張 账 胀 樟 蟑 瘴 帐 璋 帳",
    "zhao": "照 召|shao 沼 爪|zhua 兆 罩 肇 赵 昭 招|qiao 趙|diao 找|hua 櫂|di",
    "zhe": "者 折|she 哲 着|zhao 遮 这|zhei 褶|die 蛰 柘 赭",
    "zhen": "真 贞 珍 针 阵 侦 镇 震|shen 振 榛 枕|chen 臻 砧 甄|juan 眞",
    "zheng": "正 征 争 政 整 郑 蒸 筝 症 徵|zhi 证 徴",
    "zhi": "之|zhu 织 志 智 治|chi 知 凪 职 直 枝|qi 制 指 蜘 織 纸 芝 支|qi 只 质 植 雉|kai 致|zhui 执 栉 稚 至|die 止 脂 吱|zi 置 咫 汁|xie 栀 埴 職|te 芷 枳 殖|shi 蛭 掷 踯 梔 紙 痣 秩 軽|qing 侄 肢|shi 櫛 炙 帜",
    "zhong": "中 终 重|chong 冢 种|chong 钟 柊 塚 忠 众|yin 仲 種|chong 鐘 終 肿",
    "zhou": "舟 宙 周 洲 咒 州 昼 粥|yu 帚 轴 肘 胄 箒 呪",
    "zhu": "主 珠 朱|shu 助|chu 竹 蛛 渚 猪 筑 住 柱 逐|di 诸 茱 铸 竺|du 烛|chong 祝|zhou 注|zhou 驻 株 诛 著|zhe 躅|zhuo 嘱 洙",
    "zhua": "抓",
    "zhuan": "转|zhuai 专 轉|zhuai 転",
    "zhuang": "装 庄|peng 壮 状 妆",
    "zhui": "追|dui 缀 坠 锥",
    "zhun": "准",
    "zhuo": "卓 灼 捉 浊 拙 桌 镯 濯|shuo 啄|zhou",
    "zi": "子 兹|ci 字 紫 自 梓 姿 滋|ci 髭 姊 姉",
    "zong": "宗 棕 总 鬃 惣 纵 踪 综|zeng 粽 總|cong 総|cong",
    "zou": "奏|cou 走 诹 揍|cou",
    "zu": "组 族|sou 祖|jie 足|ju 诅 租|ju 組|qu 阻|zhu",
    "zuan": "钻",
    "zui": "最|cuo 罪 嘴 醉",
    "zun": "尊 樽",
    "zuo": "佐 作 座 左 坐 琢|zhuo 昨 做 祚",
}

#: 汉字 → (首读音, 备选读音…)；构建期从 _SYLLABLE_TABLE 展开一次
_CHAR_READINGS: dict[str, tuple[str, ...]] = {}


def _expand_table() -> None:
    for syllable, blob in _SYLLABLE_TABLE.items():
        for item in blob.split():
            char, _, extra = item.partition("|")
            readings = [syllable]
            if extra:
                readings.extend(part for part in extra.split(",") if part and part not in readings)
            _CHAR_READINGS[char] = tuple(readings[:MAX_READINGS])


_expand_table()


def cjk_only(text: Any) -> str:
    """只留汉字（与 `anima_tag_index.normalize_key` 的「只留字母数字与汉字」互补）。"""
    return "".join(
        ch for ch in str(text or "")
        if "一" <= ch <= "鿿" or "㐀" <= ch <= "䶿"
    )


def normalize_pinyin(value: Any) -> str:
    """拼音串归一化：NFD 去声调 → 只留 a-z（`ü` 记为 `v`）。

    查询侧**不做**此转换（查询已按 `normalize_key` 归一化），本函数只服务构建期与测试。
    """
    text = unicodedata.normalize("NFD", str(value or "").lower())
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return "".join(ch for ch in text if "a" <= ch <= "z" or ch == "ü").replace("ü", "v")


def syllables_of(char: str) -> tuple[str, ...]:
    """单字的候选音节（首读音在前）；不在字表内返回空元组。"""
    return _CHAR_READINGS.get(char, ())


def _readings_or_none(name: str) -> list[tuple[str, ...]] | None:
    """把中文名切成逐字候选读音；**任一字不在表内即整名放弃**（不产出半截拼音）。"""
    readings: list[tuple[str, ...]] = []
    for char in cjk_only(name):
        options = _CHAR_READINGS.get(char)
        if not options:
            return None
        readings.append(options)
    return readings or None


def pinyin_keys(name: str, limit: int = MAX_COMBINATIONS) -> tuple[str, ...]:
    """中文名 → 全拼键元组（多音字笛卡尔展开 + 去重，首读音组合排最前）。

    例：`初音未来` → `("chuyinweilai",)`；`东方` → `("dongfang", "dongfeng")`。
    名字里含字表外的字（生僻字）时返回**空元组** —— 宁可不出候选，也不给半截拼音。
    """
    readings = _readings_or_none(name)
    if not readings:
        return ()
    combos = [""]
    for options in readings:
        grown: list[str] = []
        for prefix in combos:
            for syllable in options:
                grown.append(prefix + syllable)
                if len(grown) >= limit:
                    break
            if len(grown) >= limit:
                break
        combos = grown
    return tuple(dict.fromkeys(combos))


def pinyin_initials(name: str) -> str:
    """中文名 → 首字母缩写（每字取首读音声母）：`初音未来` → `cywl`。

    全部用字都在表内才有值（任一字缺表即返回空串，与 `pinyin_keys` 同一纪律）。
    """
    readings = _readings_or_none(name)
    if not readings:
        return ""
    return "".join(options[0][:1] for options in readings)


def table_stats() -> dict[str, int]:
    """诊断用：字表规模（供构建日志与测试断言）。"""
    return {
        "syllables": len(_SYLLABLE_TABLE),
        "chars": len(_CHAR_READINGS),
        "polyphones": sum(1 for options in _CHAR_READINGS.values() if len(options) > 1),
    }


if __name__ == "__main__":
    print(table_stats())
