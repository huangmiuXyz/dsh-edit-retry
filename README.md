# dsh-edit-retry

**重发任意一条用户消息。** 右键会话里的一条消息，可以**重试**，也可以**先改再重试** —— DSH 都从这条消息之前的位置分叉出一个新会话，把文本当作第一句话发出去。

一个 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）客户端插件。

---

## 它做什么

在会话记录里**右键点击任意一条用户消息**，会弹出一个菜单：

| 菜单项 | 行为 |
|---|---|
| **重试** | 原样重发这条消息，不做任何编辑 |
| **编辑并重试** | 气泡原地变成编辑器（预填原文），改完再发 |
| **重试后删除原会话** | 一个开关，勾上后上面两条动作完成后会删掉源会话 |

编辑器里回车换行、`⌘/Ctrl + Enter` 保存、`Esc` 取消。两条动作的后续完全一样：

1. 从这条消息**之前**的那个事件分叉出新会话；
2. 打开这个新会话；
3. 把文本（原文或改后的）作为提示词发进去；
4. 如果开关是勾上的，**最后**删掉源会话。

整个过程复用的是 DSH 自带「分支」按钮的同一条路径，所以权限和行为跟原生功能一致。

选择后菜单就关闭了，因此进度和失败会显示在气泡下方（「正在重试…」/「正在删除原会话…」/「重试失败：原因」/「删除原会话失败：原因」）—— 编辑那条路径则复用编辑器自己的提示行。

## 删除原会话

删除是**可选、永久**的，所以它默认关闭、状态记在 `localStorage` 里（勾一次就一直是勾上的），而且**只在重试真的发出去之后**才执行 —— 重试失败会保留源会话，因为那时它是这段对话唯一的副本。

DSH **没有**给客户端插件任何删除会话的能力：workspace 面只提供 `archiveSession`（可逆，日志还在盘上），agent 协议的 `session_delete` 是给外部 ACP agent 用的，而会话存储根本没有公开的删除接口。所以删除做在**宿主半边**（`src/index.js`），顺序是有讲究的：

1. **停**：`ctx.agents.get(id).cancel()` 再等它静默（最多 15 秒）；
2. **刷盘**：`ctx.sessions.flush()`，否则 disposes 会在日志删掉之后又把它写回来；
3. **摘内存**：`sessions.detachEntered()`；
4. **删日志**：`~/.dsh/sessions/<slug>/<id>/`，裸 uuid 和 `session-` 前缀**两种拼写都删**；
5. **确认删干净**（清扫三次，因为一个在途的 dispose 可能重建目录）；
6. **最后**才清掉 workspace 记账和投影缓存。

第 5 步的顺序不是随便排的：**半删除的会话比没删的更糟** —— 日志还在但记账没了，会话会掉进 Ungrouped；记账还在但日志没了，侧边栏会留一条永远打不开的记录。

> ⚠️ **这段逻辑走的是 DSH 内部结构**（`sessions.store` / `detachEntered` / `storageDomain` 的表形状 / 磁盘布局），其中 `detachEntered` 连 DSH 自己都注明「the store has no public remove API」。每一处都做了能力探测、探测不到就跳过，所以 DSH 升级后最坏是**拒绝删除或部分删除**，而不是崩溃。但它确实可能在升级后失效，届时看气泡下方的错误信息。

删除走一条宿主注册的 HTTP 路由（`POST /dsh-edit-retry/session/delete`），要求一个自定义请求头 —— 这不是装饰：自定义头会强制 CORS 预检，而本服务不应答预检，所以外部页面无法调用这条破坏性路由。会话 id 在进入任何文件路径之前会先按白名单字符校验，并且每个候选路径都会再验证一次真的落在 `~/.dsh/sessions` 之内。

**已知小瑕疵**：删除后侧边栏那条旧记录可能要等下一次刷新才消失（DSH 没有给客户端提供刷新会话列表的接口，而整页 reload 会打断刚发出的重试流）。点它不会有反应，重新加载即可。

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
- **删除开关对两条路径都生效**，并且只在重试已经交给宿主之后才执行；重试本身失败不会删源会话。
- **中英文跟随 DSH 的语言设置**，读的是 `locale` 服务的实时快照。

## 它是怎么实现的

- **用一个下层优先级的槽位遮蔽自带渲染器。** DSH 自带的 `conversation.chat.node` 里 `user` 这一格注册在默认优先级 `0`。本插件用**同一个 key、优先级 `-1`** 注册：渲染器按优先级取每一格的第一个未被让位的条目，所以更小的数字会遮蔽自带的那条。随后插件通过 `ctx.slots.entries()` 取出**自带组件本身**来渲染，因此气泡样式、图片渲染、复制和时间戳仍然归产品所有。
- **必须转发 `locale` 座位。** `entry.locale` 是渲染器注入 `t` 翻译函数的依据，自带气泡的操作栏会调用 `t`；只转发 props 而不给这个座位会让自带节点崩溃。
- **客户端半边只 import React。** 默认的 Client 半边不允许引入任何 Harness Client 包（也就没有 JSX、没有 `react-dom`），所以菜单和编辑器全部用朴素元素加 `--dsw-*` 主题 token 画出来，因而自动跟随明暗主题。
- **宿主半边是给删除用的。** `sessions.fork`、`uiWorkspace.openSession`、`session.prompt` 都在客户端服务上，所以重试本身不需要宿主；宿主这边除了让客户端模块扫描发现这个包（并发出 `exports["./client"]`），还注册了那条删除路由。客户端和宿主是两个不共享 import 的模块图，**路由和请求头在两处各写了一遍**，自检里有一条专门断言这两种写法一致 —— 否则这个功能会永远静默 404。

## 开发

仓库自带一个**零依赖的离线自检**，覆盖清单字段、槽位遮蔽与优先级、菜单交互、两种重试形态（新建 / 分叉）、分页窗口判断、删除路由的守卫与真实文件系统行为，以及浏览器真正收到的「多模块拼接成单个 classic script」的投递形态：

```bash
node test/check.mjs
```

退出码非零即失败。测试里的假对象刻意照着真实契约写 —— 一个凭空发明数据形状的假对象什么也验证不了。删除那部分用**真的临时目录**跑：`DSH_HOME` 指向一个 `mkdtemp` 出来的目录，里面放好真实的会话目录，所以被验证的是真正的文件系统行为，不是假的对象。

## 兼容性

针对 DSH 的 client-modules 协议构建：一个 classic script，通过 `window.__ModuleLoader__.load({ id, factory })` 注册工厂，只从 `react` 取依赖。它依赖 `conversation.chat.node` 槽位、客户端 `sessions` / `uiWorkspace` / `locale` 服务，以及 `node.data` 形态的 Chat 视图节点。删除功能另外依赖宿主的 `webServer`（可选，没有就不注册路由）以及若干内部结构 —— 见上文的风险说明。

## License

[MIT](LICENSE)

---

## English

**Resend any user message.** Right-click a message in the transcript to either **retry it as-is** or **edit it first** — either way DSH forks a new session from just before that message and sends the text as its first prompt. A separated toggle below the two entries can also **delete the source session** once the retry is in flight.

A DSH plugin with both halves.

- **Why fork instead of rewriting in place?** The durable log is append-only (`seq = log.length`) and the transcript renders only append-origin surface events, so an in-place surface replace would change what the *model* sees while the *screen* kept the old text. Forking is exactly the path the shipped "branch" button uses.
- **Install:** `pnpm add github:huangmiuXyz/dsh-edit-retry` inside your profile directory, add `"dsh-edit-retry"` to that profile's `dsh.profile.bundles`, then restart DSH.
- **Two entries:** *Retry* resends the text untouched; *Edit and retry* opens an editor first. Both share one fork rule and one resend path, so only the text differs. Because the menu closes on click, the operation reports progress and failure in a status line under the bubble.
- **Deleting the source is opt-in and permanent.** DSH gives client plugins no way to delete a session — the workspace surface only archives, and the session store has no public remove API — so the delete lives in the **host half** and is reached over an HTTP route the host registers. It force-stops the agent, flushes, detaches the live entry, removes the on-disk log in both id spellings, *confirms it is gone*, and only then clears the workspace and projection accounting, because a half-deleted session is worse than an undeleted one. It runs only after the retry actually got in flight: a failed retry leaves the source alone. The route requires a custom header, which is what forces a CORS preflight and keeps other pages out, and session ids are charset-validated and path-containment-checked before touching the filesystem.
- **Boundaries:** text-only messages are retryable (attachments keep the native menu); right-click is the only entry point; interactive descendants keep their own context menu; blank text disables *Retry* while *Edit and retry* stays available; the first human prompt opens a fresh session while later prompts fork.
- **Caveat:** the delete walks into DSH internals (`sessions.store` / `detachEntered` / `storageDomain` shapes / the on-disk layout). Every step is feature-probed, so an upgrade degrades this to a refused or partial delete rather than a crash — but it can break. Also, the sidebar row for a deleted session may linger until the next reload; DSH exposes no client-side refresh, and reloading the page would interrupt the retry that was just sent.
- **How:** the plugin shadows the shipped `user` chat node at priority `-1` and renders the shipped component through `ctx.slots.entries()`, forwarding its `locale` seat so the shipped bubble keeps its `t`. The client half imports nothing but React.
- **Test:** `node test/check.mjs` — dependency-free offline self-check. The delete half runs against a real temporary `DSH_HOME`, so the filesystem behaviour under test is the real one.
