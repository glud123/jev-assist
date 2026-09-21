# jev-assist

别让贵的主模型干 grep 试错的粗活——交给 jev 排完整个仓库，主模型只负责读对的文件、写对的代码。

[![skills.sh 安装量](https://skills.sh/b/glud123/jev-assist)](https://skills.sh/glud123/jev-assist)
[English](README.md)

在一个 600 文件的仓库里开始一个任务，真正需要读的可能只有 8 个文件。找出这 8 个的成本，往往高于改动
它们本身。

现有做法各有其边界。grep 要求你先把目标表达成一个能匹配的模式，因此只能命中名字里带这个功能的文件；
让模型通读全仓库，则要付出与文件数成正比的时间和 token。两者都不适合「对每个文件问同一个问题」这类
需要规模化的判断。

jev-assist 把这类判断交给 [TypeSafe Jev](https://docs.typesafe.ai)——它对每个文件问同一个问题，拿回
的是带概率的明确答案（是/否或一个档位分），而不是一段需要人读的文字。三个命令由此而来：`rerank` 按
任务相关度给全部文件排名，`drift` 用团队约定逐个检查文件，`gate` 判断待提交的 diff 有没有碰到危险的
地方。

成本结构是这件事成立的前提：输出 token 不计费，一次调用里的多个问题并行求值，所以一次问 10 个问题和
问 1 个的开销相当。全仓库扫一遍，只有在这种计价方式下才算得过来。

## 安装

**推荐：让 coding agent 装。** 把下面这段发给它，`<你的密钥>` 换成真的密钥：

```
用 npx skills add glud123/jev-assist 安装 jev-assist skill，然后按它的 SKILL.md 把设置做完：
用密钥 <你的密钥> 执行 jev key，在当前仓库根目录写一份 jev.config.json，
最后跑 jev check 和 jev validate 20，把结果和你推断出的约定一起给我看。
```

它读过你的代码，`SKILL.md` 也写清了每一项该从哪儿推，配置的第一版交给它比你手写快。发这段之前先去
[console.typesafe.ai/keys](https://console.typesafe.ai/keys) 把密钥拿到手——没有密钥 agent 会停在
第一步，因为所有要调 API 的命令都会失败。

**手动装。**

```sh
npx skills add glud123/jev-assist          # 装 skill
jev key sk-...                             # 密钥存到 ~/.config/jev/key，0600，仓库之外
cp <skill 目录>/jev.config.example.json jev.config.json   # 在要被判断的仓库里改
jev check                                  # 校验密钥和配置
```

要求 Node 18 以上（用到内置 `fetch`），除此之外没有依赖。任何支持 skills 的 agent 都能用——Claude
Code、Codex、Cursor 读的是同一份 `SKILL.md`，按路径调脚本。

按 skill 安装不会把 `jev` 放进 PATH。想在自己的 shell 里直接敲这个命令：

```sh
git clone https://github.com/glud123/jev-assist && cd jev-assist && npm link
```

**卸载。** 只删 skill 不够——安装时写进去的密钥、配置，还有可能装上的 pre-commit hook，都在 skill
目录之外，而一个调 `jev gate` 的 hook 在脚本没了之后会让每次提交都失败。把下面这段发给 agent，完整
清单在 `SKILL.md` 里：

```
按 jev-assist 的 SKILL.md 里 Uninstall 那节把这个 skill 卸载掉：pre-commit hook、存下来的
密钥、所有 JEV_ 环境变量、每个仓库里的配置和产出，以及 skill 本身。不确定的先给我看再删。
```

手动：

```sh
rm -f .git/hooks/pre-commit              # 仅当它里面只有 `jev gate`
rm -f ~/.config/jev/key                  # 每台机器一份（设了 $XDG_CONFIG_HOME 就在那下面）
rm -f jev.config.json .jev-rerank.json   # 每个被判断的仓库一份，在它的根目录执行
grep -rn JEV_ ~/.zshrc ~/.bashrc .env    # 留在 rc 文件里的密钥仍然是活的
npm unlink -g jev-assist                 # 仅当你跑过 npm link
```

## 在 agent 会话里怎么用

skill 的作用是让 agent 在该用的时候自己用。你不需要记命令，用自然语言说明意图即可，前提是会话的工作
目录就是那个要被判断的仓库。

```
先用 jev-assist 找出这个任务涉及哪些文件，再动手：给订单表加 CSV 导出。
```

```
用 jev-assist 扫一遍 src/**/*.tsx，看哪些文件偏离了我们的约定，按严重程度给我排个序。
```

```
提交前用 jev-assist 检查一下已暂存的改动有没有碰到危险的地方。
```

agent 会按 `SKILL.md` 里的说明调 `scripts/jev.mjs`，把排名和命中项读给你听。如果它没有自己触发，在
提示里点名 `jev-assist` 就行。第一次在新仓库上用，让它先跑 `jev validate 20`——排名准不准是一个可以
测出来的事实，不是需要相信的说法。

## 它具体做什么

jev-assist 用模型做三类逐文件判断——任务相关度、约定符合度、diff 风险，另用一个命令验证准确率：

**`jev rerank "<任务>"`** 按任务相关度给全部被跟踪的文件排名，输入一句话任务描述。705 文件的仓库
上重放 10 个真实提交：前 20 条覆盖实际改动文件的 68%，前 40 条覆盖 80%。对比 grep 的优势在于命中名
称不含任务关键词的文件——图片上传任务中，与应用其他部分毫无关联的共享上传服务排到第 6。打印条数之外
的排名并不可靠，应顺着头部结果的 import 继续追踪。

**`jev drift [glob]`** 用团队约定逐个检查文件，每个文件一次调用。输入是约定本身而非匹配模式，哪些
代码违反它由模型判断，因此能查出 grep 无法表达的违规：未翻译的文案、绕开请求封装的调用、脱离
store 的服务端状态。问题数量几乎不影响成本，一次可检查多项。

**`jev gate [ref]`** 检查已暂存的 diff 是否触碰风险点，命中即非零退出，可直接用作 pre-commit 钩
子。四个真实提交的风险分：解密功能 0.99，吞掉错误的修补 0.91，CSS 微调 0.64，纯注释改动 0.03；每
个 diff 0.7–1.8 秒。类型检查、lint 和单元测试都无法发现「悄悄丢弃用户输入」这类改动，这是它存在的
理由。

**`jev validate [n]`** 用你的 git 历史验证 rerank 在本仓库的准确率：把历史提交当任务重放，以每次
提交实际改动的文件为标注打分。准确率不跨仓库通用，新仓库先跑它。

## 命令

```sh
cd /path/to/your/repo
jev check                                    # 先查密钥和配置，再做别的
jev validate 20                              # 从这里开始：它准不准？
jev rerank "给订单表加上 CSV 导出"
jev drift 'src/**/*.tsx'
jev gate                                     # 已暂存的改动
jev gate HEAD~1                              # 某个历史提交
```

| 命令 | 回答的问题 | 成本 |
| --- | --- | --- |
| `jev rerank "<任务>" [--json]` | 这个任务涉及哪些文件？ | 每 `batchSize`（默认 60）个文件 1 次调用 |
| `jev validate [n]` | rerank 在**我的仓库**上够准吗？ | n × rerank |
| `jev drift [glob]` | 哪些文件偏离了我们的约定？ | 每个文件 1 次调用 |
| `jev gate [ref]` | 这个 diff 是否碰到了危险的东西？ | 每个 diff 1 次调用 |
| `jev check` | 我的密钥和配置格式对吗？ | 免费，不联网 |
| `jev key <k>` | 把 API 密钥存到仓库之外 | 免费，不联网 |

`rerank` 只打印前 N 条（`topN`，默认 20）。需要没打印出来的其余名次时加 `--json`，它会把完整排名额
外写进仓库根目录的 `.jev-rerank.json`，记得把这个文件加进 `.gitignore`。

打印出来的列表要看分数，不要按行数读。`topN` 是固定条数，不是相关度筛选——一个实际只牵涉 3 个文件的
任务同样会打印 20 行，后面那 17 行只是本次排名里最不无关的文件而已。

分数是档位，不是概率：0 到 3，3 是「很可能得读或改」，2 是「展示了该跟随的既有模式」，1 是背景文件，
0 是不相关。2.5 及以上的全都要读。下面如果有明显断崖就在那儿切，但不要等断崖——前 20 名总跨度只有半
分，意思是没有文件脱颖而出，而不是这 20 个都是候选。

### 接进 pre-commit

一句话交给 agent：

```
把 jev gate 接进这个仓库的 pre-commit 钩子；已经有钩子的话追加一行，不要覆盖原有内容。
```

自己动手：

```sh
h=.git/hooks/pre-commit
[ -e "$h" ] && echo "$h 已存在 —— 请自行往里加一行 'jev gate'" ||
  { printf '#!/bin/sh\njev gate\n' > "$h" && chmod +x "$h"; }
```

没有钩子时写一个只含 `jev gate` 的钩子并加上可执行权限，已经有钩子（Husky、pre-commit 都会装一个）
时只提示、不改动。

## 配置

配置文件按项目区分：`jev.config.json` 放在被判断的那个仓库的根目录，每个仓库一份，互不共用，也不要
放进 jev-assist 这个仓库。原因是问题的措辞依赖具体代码库——在 i18next 应用里能抓到未翻译文案的问法，
放到一个没有 i18n 的应用里字面上就不成立，只会让每个文件都被判为违规。

```jsonc
{
  "description": "一个用 TanStack Query 和 i18next 构建的 React 管理后台。",
  "include": ["src/**/*.ts", "src/**/*.tsx"],

  "conventions": {
    "hardcoded_copy": {
      "ask": "这个文件里是否内联了用户可见的 UI 文案，而没有走 i18next 的 key？",
      "drift": "存在硬编码的用户可见文案",
      "ok": "所有文案都已翻译，或这个文件没有 UI 文案。mock 数据和 fixture 不算。"
    }
  },

  "gates": {
    "data_loss": {
      "ask": "这个改动是否可能丢失或静默丢弃用户输入的数据？",
      "risk": "存在丢失用户输入的现实路径",
      "ok": "所有路径上用户数据都被保留"
    }
  },

  "exemptions": {
    "hardcoded_copy": ["/mocks/", ".test."]
  },

  "batchSize": 60,
  "topN": 20,
  "threshold": 0.7,
  "validateK": [20, 40]
}
```

顶层字段：

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `description` | 是 | — | 一句话说明这个项目是什么、用什么技术栈。每次提问都会带上它作为上下文，所以要点出下面约定里提到的那些库 |
| `include` | 是 | — | glob 数组，界定 `rerank` 和 `drift` 的文件池；只覆盖 git 已跟踪的文件。用 `git ls-files '<glob>' \| wc -l` 确认它真的匹配到了东西 |
| `conventions` | 否 | — | `drift` 检查的约定项，键名自取。只写这个代码库真正在守的约定 |
| `gates` | 否 | — | `gate` 检查的风险项，键名自取，结构与 `conventions` 相同，只是针对 diff 提问 |
| `exemptions` | 否 | — | 按约定名给出路径子串数组，路径包含其中任一片段的文件跳过该项检查 |
| `batchSize` | 否 | `60` | `rerank` 每次调用打分的文件数 |
| `topN` | 否 | `20` | `rerank` 打印的条数。是固定条数，不是相关度筛选 |
| `threshold` | 否 | `0.7` | 概率达到这个值才算命中，`drift` 和 `gate` 共用 |
| `validateK` | 否 | `[20, 40]` | `validate` 取排名前 K 条计算召回率，对应输出里的 `recall@20`、`recall@40` |

`conventions` 和 `gates` 里每一项的子字段：

| 子字段 | 说明 |
| --- | --- |
| `ask` | 向模型提的判断题，答案为是/否加概率。锚定到具体模块（"`src/services` 里的那个请求封装"），不要锚定到抽象原则 |
| `drift` / `risk` | 命中时打印的那句话。`conventions` 用 `drift`，`gates` 用 `risk` |
| `ok` | 什么情况算通过。例外写在这里，这是调优的主要位置 |

`description` 和 `include` 缺任何一个 `jev check` 都会拒绝，它同时会检查占位符没换、分组空着、豁免
项指向一个不存在的约定这类机械性问题。它读不到你的代码，所以判断不了问题本身在这个仓库里成不成立：
一条约定去问一个并不存在的请求封装，check 会放过，然后让每个文件都被判为违规。所以让 agent 说清楚哪些约定
是它读代码读出来的、哪些是猜的，问题都在猜的那几个里。

调优发生在 `ok` 这段文字里。你会看到的噪音几乎都是那种字面正确、但不值得动手的判断，比如一个有意为
之的 `catch {}`、mock 图表数据里的文案。把这件事在 `ok` 里说清楚。提高 `threshold` 不解决这件事：噪
音的分数往往不低（那个 `catch {}` 就是 0.91），线提到 0.95 之后它照样在，被挡掉的反而是 0.75 到 0.9
那些真问题。

### 密钥与端点

`jev key <API_KEY>` 把密钥写到 `~/.config/jev/key`，权限 0600；设了 `XDG_CONFIG_HOME` 则写到
`$XDG_CONFIG_HOME/jev/key`。不放在仓库里。

端点由密钥前缀决定，因为两个提供方接受的请求体是一样的：

| 密钥前缀 | 提供方 | 端点 | 模型 |
| --- | --- | --- | --- |
| `sk-or-…` | OpenRouter | `https://openrouter.ai/api/alpha/decisions` | `~typesafe/jev-latest` |
| 其他 | TypeSafe 直连 | `https://api.typesafe.ai/v1/systemone` | `jev-latest` |

三个环境变量可以覆盖上面的推导结果：

| 变量 | 作用 |
| --- | --- |
| `JEV_API_KEY` | 使用的密钥。优先于存储的密钥文件，设了就不再读文件 |
| `JEV_API_URL` | 请求的端点，替换由前缀推导出的值。用于自托管网关 |
| `JEV_MODEL` | 请求的模型，替换由前缀推导出的值。用于锁定版本 |

后两个互不影响：只设 `JEV_MODEL` 时，端点仍然按密钥前缀推导。`jev check` 会打印掩码后的密钥，以及实
际生效的提供方、端点和模型——排查调用问题前先看这一行，因为密钥发错提供方返回的只是一个普通的 401。

## 先验证，再信任

类型化输出保证的是答案的形状，关于答案本身它什么都不保证。

```sh
jev validate 20
```

一条提交标题就是一个任务，这次提交改了哪些文件就是答案。`validate` 往回走，跳过 merge 提交，直到凑
够 n 个碰了 `include` 范围内文件的提交，用每条标题对整个仓库排名，再按排名前 K 条各算一次召回率——
实际改动的文件被排进前 K 条的比例，对应输出里的 @20、@40 列。

```
  #  task                                 truth   @20   @40
  1  fix avatar upload failing on Safari      7     5     6
  2  add CSV export to the orders table       4     4     4
  3  bump deps and fix lint                  12     2     3

  recall@20 0.48   recall@40 0.57   (23 files over 3 commits)
  worst: "bump deps and fix lint" — 2/12
```

最后那行值得跟第一行一样认真读。升级依赖和大规模重命名没有语义信号，分数注定难看——这说的是任务本
身，不是工具有毛病，它告诉你什么时候该跳过 `rerank` 直接 grep。

如果你打算自己用 `git show --name-only` 写一个对比，有两处手写容易搞错：这次提交**新增**的文件要排
除，任务被写下来的时候它们还不存在，算进去会虚抬召回率；被**删除**的文件在今天的代码树里已经没了，
根本没法参与排名。另外没碰到任何可排名文件的提交会被跳过而不是记零分，所以 `validate 20` 实际回溯
的提交数可能超过二十个。

在新仓库上信 `drift` 或 `gate` 之前也先跑它。它只给 `rerank` 打分，但一个 `rerank` 分数偏低的仓库，
需要先打磨的是配置里的措辞。

## 已知局限

- **rerank 看不见结构性耦合。** 一个仅仅因为它 import 的东西变了而被改动的文件没有语义信号，有一个
  这样的文件排在了 705 个文件中的第 121 位。顺着头部结果的 import 往下找。
- **正确和可行动不是一回事。** 验证里翻出过一个 0.91 的 `silent_catch`，对象是一个刻意留空、上面还
  写了注释说明为什么这个失败是安全的 catch。给调判定标准留出时间。一个总在喊狼来了的审计会被静音，
  而一个被静音的门禁一边花钱一边给你一种覆盖到了的错觉。
- **没有重试，没有并发控制。** 顺序调用，不做 429 退避。几千个文件以内没问题，再往上要加 `p-limit`
  和指数退避。
- **不要评判你自己刚生成的候选项。** 如果状态和选项都出自同一个模型，那个概率衡量的只是它的自我一
  致性，别的什么都不是。而它看起来会很像验证。

## 许可

MIT
