# jev-assist

[![skills.sh installs](https://skills.sh/b/glud123/jev-assist)](https://skills.sh/glud123/jev-assist) [![CI](https://github.com/glud123/jev-assist/actions/workflows/ci.yml/badge.svg)](https://github.com/glud123/jev-assist/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/jev-assist)](https://www.npmjs.com/package/jev-assist)

[English](README.md)

搜索结果一次回来几百上千条：读不完，也猜不得。把候选从 stdin 灌进来（`grep -rn`、
`git ls-files`、测试输出，原样即可，无需重新格式化），每个候选都会得到一个校准过的
分数——已排序，带精确总数和切分线。池子是 40 条还是 4000 条，回复都只有约 30 行。
底层是 [TypeSafe Jev](https://docs.typesafe.ai) 的三种结构化判断：`noul`（这条命中是
真的吗）、`choice`（它是什么）、`score`（它有多严重）。

搜索负责告诉你命中在哪，这里负责判断每个命中**是什么**。找东西永远是
`grep`/`rg`/`Glob` 的事，本工具刻意不做检索。

## 示例

```sh
$ grep -rn "getUser" src/ | jev noul '这行在生产代码里真正调用了用户 API，不是测试、mock 或注释'
jev noul · 4 candidate(s) · 1 call(s) · 1046ms · 459 input tok · 0/4 cache hit(s)
  "this line calls the user API in production code, not a test, mock, or comment"
  yes 2 / 4 at p >= 0.70
  --- cut: read above (2 row(s); p >= 0.70; 2 below) ---
0.72	"src/api/user.ts:12:  const user = await getUser(id);"
0.70	"src/hooks/useAuth.ts:22:  return getUser(session.token);"
```

切分线以上的就是答案。横幅里的每个数字都统计自完整候选池，从不截断。

## 安装

需要 Node 18+，以及一个 [TypeSafe](https://docs.typesafe.ai) 或
[OpenRouter](https://openrouter.ai) 的 API key。

### Agent 安装

**从 1.0.0 之前的版本升级：** 旧版本会安装 hooks 和配置文件，现已全部移除。把下面这句
发给你的 agent，删干净后再重新安装：

```text
把 jev-assist 这个 skill 完全删除，包括旧版本遗留的 hooks、配置文件和其他产物。
```

现在的版本只写三样东西：skill 目录、key 文件、缓存。

**立即使用**：把下面这段 prompt 发给你的编码 agent：

```text
Run `npx skills use "https://github.com/glud123/jev-assist" --skill "jev-assist"` and follow the generated skill instructions now. Read its complete output, redirecting it to a temporary file first if necessary. Resolve relative paths from the supporting-files directory it provides.
```

**或安装 skill**，让它在每次会话里都可用：

```sh
npx skills add https://github.com/glud123/jev-assist --skill jev-assist
```

只装 skill 的话 `jev` 不在 PATH 上，请按绝对路径调用脚本
（`node /path/to/jev-assist/scripts/jev.mjs …`）。

### 人工安装

在自己终端里直接用 CLI：

```sh
npm i -g jev-assist   # 或者直接按路径调用 scripts/jev.mjs
```

### API key

只需配置一次，存放在仓库之外：

```sh
jev key sk-or-v1-...   # 仅装 skill 时：node /path/to/jev-assist/scripts/jev.mjs key sk-or-v1-...
```

key 保存在 `~/.config/jev/key`（权限 0600），环境变量 `JEV_API_KEY` 优先。`sk-or-` 前缀
的 key 走 OpenRouter，其余直连 TypeSafe（`JEV_API_URL`/`JEV_MODEL` 可覆盖）。不要把 key
写进任何被 Git 跟踪的文件。

以 skill 方式使用但还没配 key？第一次判断调用会在几毫秒内失败，并给出确切的修复
命令——agent 看到它就会停下来向你要 key。没有预检，没有按项目的配置文件，问题的措辞
就是接口。

## 用法

一个形状，三种判断，子命令决定数字的类型：

```sh
# 这些命中里哪些是真的（每行一个 0–1）
grep -rn "getUser" src/ | jev noul '这行在生产代码里真正调用了用户 API，不是测试、mock 或注释'

# 每个文件属于哪一层（每行一个标签）
git ls-files 'src/**' | jev choice '这个文件属于哪一层？' \
  --opt api:"HTTP handler 或路由" --opt db:"schema、迁移或查询" --opt ui:"组件或视图"

# 每个 TODO 的严重程度（每行一个级别）
grep -rn "TODO\|FIXME" src/ | jev score '这个 TODO 还成立吗？' \
  --level 0:"已过期，代码早变了" --level 1:"仍有效，不紧急" --level 2:"仍有效且阻塞已知 bug"
```

Flags：`--top N`（固定切分线）、`--by-file N` / `--by-dir N`（对选中行按路径或目录做
统计，前 N 名列出，其余精确求和）、`--json`（输出全部行，不截断）、`--fresh`（重新
判定，结果仍合并进缓存）。任何错误都以退出码 1 结束：失败的调用绝不会输出一个看起来
像 0 的计数。

面向 agent 的路由规则、问题措辞指南和实测失效模式，见 [SKILL.md](SKILL.md)。

## 隐私

每次调用会把候选行、问题和 API key 发给 Jev 端点。判定结果按「问题 + 行」缓存在
`~/.cache/jev/cache.json`——jev 的设计是自洽的，缓存里的判定就是判定，`--fresh` 可
强制重算。如果仓库不能离开本机，请不要使用 jev。

## 卸载

删除 skill 目录，然后删除 `~/.config/jev/key`（这是凭据，理应删掉）和 `~/.cache/jev`；
如果 `which jev` 有输出，再执行 `npm unlink -g jev-assist`。除此之外本工具不写任何东西：
无配置文件、无 hooks、不动任何仓库。

## 不适合

检索；小到一眼能读完的池子；编译器、linter 或测试能判定的事；判断你自己刚生成的候选。

MIT — 见 [LICENSE](LICENSE)。
