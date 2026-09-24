# jev-assist

[![skills.sh installs](https://skills.sh/b/glud123/jev-assist)](https://skills.sh/glud123/jev-assist) [![CI](https://github.com/glud123/jev-assist/actions/workflows/ci.yml/badge.svg)](https://github.com/glud123/jev-assist/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/jev-assist)](https://www.npmjs.com/package/jev-assist)    [English](README.md)

给编码 agent 的候选洪水一个校准过的数。任何搜索的输出从 stdin 进来——原样 `grep -rn`、
`git ls-files`、测试运行，无需重新格式化——回来的是排好序的列表，带切分线和精确总数：
池子是 40 条还是 4000 条，回复都是那 ~30 行。基于
[TypeSafe Jev](https://docs.typesafe.ai) 的三种结构化判断：`noul`（这个命中是真的吗）、
`choice`（它是什么）、`score`（它有多严重）。

搜索告诉你命中在哪；这里判断每个命中**是什么**。找东西永远是 `grep`/`rg`/`Glob` 的工作——
本工具不做检索，这是设计决定。

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

读切分线以上的部分，那就是答案。横幅里的每个数字都覆盖全量池子，绝不是截断值。

## 安装

需要 Node 18+ 和一个 [TypeSafe](https://docs.typesafe.ai) 或
[OpenRouter](https://openrouter.ai) 的 API key。

**从 1.0.0 之前的版本升级：** 旧版本带有 hooks 和配置文件，现在已经全部移除。把下面这句
发给你的 agent，删除完成后再重新安装：

```text
把 jev-assist 这个 skill 完全删除，包括旧版本遗留的 hooks、配置文件和其他产物。
```

现在的版本只写三样东西：skill 目录、key 文件、缓存。

**让 agent 立即使用**——把下面这段作为 prompt 发给你的编码 agent：

```text
Run `npx skills use "https://github.com/glud123/jev-assist" --skill "jev-assist"` and follow the generated skill instructions now. Read its complete output, redirecting it to a temporary file first if necessary. Resolve relative paths from the supporting-files directory it provides.
```

**安装 skill**，让它在每次会话里都对你的 agent 可用：

```sh
npx skills add https://github.com/glud123/jev-assist --skill jev-assist
```

**或全局安装 CLI**，让自己终端里也有 `jev`：

```sh
npm i -g jev-assist   # 或者直接按路径调用 scripts/jev.mjs
```

只装了 skill 时 `jev` 不在 PATH 上——按绝对路径调用脚本
（`node /path/to/jev-assist/scripts/jev.mjs …`）。

### API key

存一次，放在仓库之外：

```sh
jev key sk-or-v1-...   # 仅装 skill 时：node /path/to/jev-assist/scripts/jev.mjs key sk-or-v1-...
```

key 存到 `~/.config/jev/key`，权限 0600；环境变量 `JEV_API_KEY` 优先。`sk-or-` 前缀的 key
走 OpenRouter，其余直连 TypeSafe（`JEV_API_URL`/`JEV_MODEL` 可覆盖）。绝不要把 key 写进
被跟踪的文件。

以 skill 方式使用且未设置 key 时，agent 会在第一次判断调用时停下来向你要 key——缺 key
会在几毫秒内失败并给出确切的命令，那一刻就是 agent 开口的时候。不做 key 预检，没有按项目
的配置文件：问题就是接口。

## 用法

一个形状，三种判断——子命令决定数字的类型：

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

Flags：`--top N`（固定切分线）、`--by-file N` / `--by-dir N`（对选中行按路径/目录做统计——
前 N 名，其余精确求和）、`--json`（输出全部行，不截断）、`--fresh`（重新判定，结果仍合并
进缓存）。任何错误都以退出码 1 结束——失败的调用绝不会打印一个看起来像 0 的计数。

面向 agent 的路由规则、问题措辞指南和实测失效模式，见 [SKILL.md](SKILL.md)。

## 隐私

每次调用会把候选行、问题和 API key 发给 Jev 端点。判定结果缓存在
`~/.cache/jev/cache.json`，按问题+行做键——jev 的设计是自洽的，缓存里的判定就是判定；
`--fresh` 重新计算。如果仓库不能离开这台机器，就不要对它使用 jev。

## 卸载

删除 skill 目录，然后：`rm -f ~/.config/jev/key`（这是凭据——删掉它就是目的）、
`rm -rf ~/.cache/jev`；如果 `which jev` 有结果，再 `npm unlink -g jev-assist`。
没有写过其他任何东西：无配置文件、无 hooks、任何仓库里都没有。

## 不适合

检索；小到能直接读完的池子；编译器/linter/测试能判定的事；判断你自己刚生成的候选。

MIT — 见 [LICENSE](LICENSE)。
