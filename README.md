# dsh-edit-retry

**重发任意一条用户消息。** 右键会话里的一条消息，可以**重试**，也可以**先改再重试** —— DSH 都从这条消息之前的位置分叉出一个新会话，把文本当作第一句话发出去。

一个 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）客户端插件。

---

## 它做什么

在会话记录里**右键点击任意一条用户消息**，会弹出一个两项菜单：

| 菜单项 | 行为 |
|---|---|
| **重试** | 原样重发这条消息，不做任何编辑 |
| **编辑并重试** | 气泡原地变成编辑器（预填原文），改完再发 |

编辑器里回车换行、`⌘/Ctrl + Enter` 保存、`Esc` 取消。两条路径的后续完全一样：

1. 从这条消息**之前**的那个事件分叉出新会话；
2. 打开这个新会话；
3. 把文本（原文或改后的）作为提示词发进去。

整个过程复用的是 DSH 自带「分支」按钮的同一条路径，所以权限和行为跟原生功能一致。

选择后菜单就关闭了，因此**重试**的进度和失败会显示在气泡下方（「正在重试…」/「重试失败：原因」）—— 编辑那条路径则复用编辑器自己的提示行。

## 为什么是「分叉」而不是原地改写

DSH 的持久化日志是**只能追加**的（`seq = log.length`），而且会话记录只渲染追加来源的 surface 事件。所以原地替换 surface 只会让**模型看到的内容**变了、而**屏幕上还是旧文本** —— 一种静默的不一致。分叉没有这个问题，因为它是产品自己就在用的做法。

## 安装

把插件装进某个 profile 的依赖里，再把它登记进该 profile 的 bundle 列表。

```bash
cd ~/.dsh/profiles/<你的 profile>
pnpm add github:huangmiuXyz/dsh-edit-retry
```

然后编辑该 profile 的 `package.json`，把包名加进 `dsh.profile.bundles`（顺序即层级顺序，插件放在内置 bundle 之后）：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-edit-retry"
      ]
    }
  }
}
```

重启 DSH（或刷新 Web 界面）即可生效。

### 从本地克隆安装

开发时用 `link:` 更顺手，改完代码刷新页面就生效，不用重新装包：

```bash
cd ~/.dsh/profiles/<你的 profile>
pnpm add link:/绝对路径/dsh-edit-retry
```

同样要把 `"dsh-edit-retry"` 加进 `dsh.profile.bundles`。

## 行为与边界

- **右键是唯一入口。** 没有重试按钮，也没有双击 —— 按钮得挤进 DSH 自带的操作栏（复制 + 时间），而那一行渲染在自带组件内部，从外面接不进去；双击则会和浏览器「选中一个词」的手势打架。
- **只处理纯文本消息。** 带附件的消息没法当文本重发，因此保留浏览器原生右键菜单。
- **消息内的交互元素**（链接、按钮、输入框）保留它们自己的右键菜单，插件不会抢占。
- **消息为空白时「重试」置灰** —— 重发一个空提示词没有意义；「编辑并重试」仍然可用，它也是给这种消息补上文本的唯一途径。
- **第一条消息**走「新建会话」而不是「分叉」。理由见下面的注释；简单说，在 Turn 1 内部切分会留下一个空的「用时 N 秒」行，而在 Turn 1 之前切分会让子会话重发原文。第一条之外的消息才做分叉。
- **两条菜单项共用同一套分叉规则** —— 是消息的位置决定走新建还是分叉，跟选了哪一项无关。
- **重试会话会落在和源会话相同的 Workspace 分组里**，不会掉进 Ungrouped。
- **中英文跟随 DSH 的语言设置**，读的是 `locale` 服务的实时快照。

## 它是怎么实现的

- **用一个下层优先级的槽位遮蔽自带渲染器。** DSH 自带的 `conversation.chat.node` 里 `user` 这一格注册在默认优先级 `0`。本插件用**同一个 key、优先级 `-1`** 注册：渲染器按优先级取每一格的第一个未被让位的条目，所以更小的数字会遮蔽自带的那条。随后插件通过 `ctx.slots.entries()` 取出**自带组件本身**来渲染，因此气泡样式、图片渲染、复制和时间戳仍然归产品所有。
- **必须转发 `locale` 座位。** `entry.locale` 是渲染器注入 `t` 翻译函数的依据，自带气泡的操作栏会调用 `t`；只转发 props 而不给这个座位会让自带节点崩溃。
- **客户端半边只 import React。** 默认的 Client 半边不允许引入任何 Harness Client 包（也就没有 JSX、没有 `react-dom`），所以菜单和编辑器全部用朴素元素加 `--dsw-*` 主题 token 画出来，因而自动跟随明暗主题。
- **宿主半边是空的**（`apply() {}`）。`sessions.fork`、`uiWorkspace.openSession`、`session.prompt` 都在客户端服务上，宿主这边只需要那行插件记录存在 —— 正是它让客户端模块扫描发现这个包，并把 `exports["./client"]` 发给浏览器。

## 开发

仓库自带一个**零依赖的离线自检**，覆盖清单字段、槽位遮蔽与优先级、菜单交互、两种重试形态（新建 / 分叉）、分页窗口判断，以及浏览器真正收到的「多模块拼接成单个 classic script」的投递形态：

```bash
node test/check.mjs
```

退出码非零即失败。测试里的假对象刻意照着真实契约写 —— 一个凭空发明数据形状的假对象什么也验证不了。

## 兼容性

针对 DSH 的 client-modules 协议构建：一个 classic script，通过 `window.__ModuleLoader__.load({ id, factory })` 注册工厂，只从 `react` 取依赖。它依赖 `conversation.chat.node` 槽位、客户端 `sessions` / `uiWorkspace` / `locale` 服务，以及 `node.data` 形态的 Chat 视图节点。

## License

[MIT](LICENSE)

---

## English

**Resend any user message.** Right-click a message in the transcript to either **retry it as-is** or **edit it first** — either way DSH forks a new session from just before that message and sends the text as its first prompt.

A client-side plugin for DeepSeek Harness (DSH).

- **Why fork instead of rewriting in place?** The durable log is append-only (`seq = log.length`) and the transcript renders only append-origin surface events, so an in-place surface replace would change what the *model* sees while the *screen* kept the old text. Forking is exactly the path the shipped "branch" button uses.
- **Install:** `pnpm add github:huangmiuXyz/dsh-edit-retry` inside your profile directory, add `"dsh-edit-retry"` to that profile's `dsh.profile.bundles`, then restart DSH.
- **Two entries:** *Retry* resends the text untouched; *Edit and retry* opens an editor first. Both share one fork rule and one resend path, so only the text differs. Because the menu closes on click, the retry reports progress and failure in a status line under the bubble.
- **Boundaries:** text-only messages are retryable (attachments keep the native menu); right-click is the only entry point; interactive descendants keep their own context menu; blank text disables *Retry* while *Edit and retry* stays available; the first human prompt opens a fresh session while later prompts fork.
- **How:** the plugin shadows the shipped `user` chat node at priority `-1` and renders the shipped component through `ctx.slots.entries()`, forwarding its `locale` seat so the shipped bubble keeps its `t`. The client half imports nothing but React.
- **Test:** `node test/check.mjs` — dependency-free offline self-check.
