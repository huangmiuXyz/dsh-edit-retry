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

1. 从这条消息**之前**的那个**已闭合的 turn** 分叉出新会话（见下面的「为什么重试前面不会多一行」）；
2. 打开这个新会话；
3. 把源会话**当前选中的模型**装到新会话上（见下一节），再把文本（原文或改后的）作为提示词发进去；
4. 如果开关是勾上的，**最后**删掉源会话。

整个过程复用的是 DSH 自带「分支」按钮的同一条路径，所以权限和行为跟原生功能一致。

选择后菜单就关闭了，因此进度和失败会显示在气泡下方（「正在重试…」/「正在删除原会话…」/「重试失败：原因」/「删除原会话失败：原因」）—— 编辑那条路径则复用编辑器自己的提示行。

## 为什么重试前面不会多一行「用时 N 秒」

分叉点默认是「这条消息的前一个事件」（`seq - 1`），而它**必然落在消息自己那个 turn 内部**：DSH 先 `turn/start`、再把提示词 splice 进 inbox，最后才写下转录用来挂气泡的 `user/message`。切在半个 turn 上，DSH 的 `buildForkSeed` 就会用 `openTurnClosers` 补一条合成的 `step/end` + `turn/end {kind:"forked"}` —— 背后没有任何用户消息，转录把它渲染成重试内容**前面**的一行空「用时 N 秒」（实测跨度十几毫秒，取整显示成 1 秒）。

所以插件把分叉点改到**上一个 turn 的 `turn/end`**（一个平衡边界，`openTurnClosers` 扫完发现没有开着的 turn，就不补任何东西），前提是这条消息**开了它自己的 turn**，并且满足下面几条：

- **消息是该 turn 的第一条** → 切到上一个 `turn/end`。它同时也在这条提示词的 inbox splice **之前**，所以子会话不会重发原文（跟第一条消息改走「新建会话」是同一个理由）。
- **上一个 turn 结束时 inbox 里还压着没被取走的提示词** → 保持 `seq - 1`。被用户中断（`aborted`）的 turn 会把已 splice 进 inbox 的提示词留在队列里，等下一个 turn 才取走；切到那个 `turn/end` 会把这条**源会话从没回答过**的文本一起继承给子会话，让它先重发一遍。所以分叉前先数一遍 inbox 的净存量（Σ`inserted` − Σ`removedCount`），非空就不切。
- **消息是 turn 中途插进去的**（steering）→ 保持 `seq - 1`。它前面没有任何已闭合边界，往前切会连带丢掉同一 turn 里更早的消息，那比多一行严重。
- **事件窗口还没加载完**（`hasMore`）→ 同样保持 `seq - 1`：看不到开头就既不能断言「这是第一条」，也不能信一个自己看不见起点的边界。

## 重试跑在哪个模型上

**跑在你现在选中的那个模型上** —— composer 里显示的是哪个，重试就用哪个。

这件事需要显式做，因为 DSH 的两条规则叠在一起会得出一个意外结果：分叉只继承**到重试点为止的事件前缀**，而宿主是**按会话自己的日志**决定模型的（该会话最后一条 `request/header` 的路由，或一条尚未被请求消费掉的 `model/selection`）。于是「先切了模型，再往上重试一条旧消息」——也就是最自然的用法——子会话会跑在那条旧消息当时用的模型上，跟你眼前选中的那个无关。

所以插件在分叉**之前**读源会话的 `modelSelection` 投影（`next`：有待生效的选择就是它，否则是最后一次请求的路由，正是 composer 模型控件渲染的那个值），并在这个新会话的**第一条提示词之前**调用宿主那条 `session/selectModel` —— composer 模型控件用的也是同一条 RPC。宿主把它记成一条 `model/selection` 事件，于是子会话的记录、模型控件、以及真正跑起来的模型三者一致；历史是别的模型生成的时，DSH 自己还会在记录里插一条「model changed」提示，把这件事讲清楚。

- 目标会话本来就解析成同一个路由时**不调用**：单模型会话里的重试不会平白多出一条事件（也不会多写一次默认值）。
- 取不到选择（会话从没选过、投影还没加载）或路由已经不可用时，重试**照常发出**，只在控制台留一条警告 —— 带模型过来是附加的，不能反过来把重试弄失败。
- ⚠️ 宿主对这条 RPC 的处理和手动选模型完全一样：它会同时把这个选择存为**部署默认值**。所以如果源会话当前的模型是从历史继承来的（不是刚手动选的），一次重试也会顺带把它变成新会话的默认模型。这是 DSH 自身的语义，插件没有另立一套。

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

插件是装进某个 profile 的**普通依赖**，并在该 profile 的 `dsh.profile.bundles` 里登记一层：

```bash
dsh plugin --profile <你的 profile> add github:huangmiuXyz/dsh-edit-retry
```

`dsh plugin` 就是把参数转发给该 profile 目录里的 pnpm，装完再**自动**把新依赖登记进 `dsh.profile.bundles` —— 本包声明了 `dsh.bundle`，所以这一步不用手改 `package.json`。重启 DSH（或刷新 Web 界面）即可生效。

> **为什么是 `github:` 而不是裸包名？** 本包还没发布到 npm，`add dsh-edit-retry` 会 404；GitHub 源是当前唯一可用的写法。包内没有 `prepare`／构建脚本，所以也不会被 pnpm 的构建脚本审批（`allowBuilds`）挡住。

> **桌面端（DSH Desktop）**：`--profile desktop` 由 Electron 应用独占，`dsh plugin` 会直接拒绝（`profile "desktop" is managed exclusively by the Electron application`），所以桌面端这份要在应用内的插件管理入口里装同一个 GitHub 源。

> **如果该 profile 的 `dsh.profile.bundles` 里有解析不到的条目**（典型是指向已删除目录的 `link:` 包），`dsh plugin` 会在包**装完之后**的登记阶段报错退出、不写 bundles —— 依赖其实已经装好了。清掉那条悬空条目再跑一次，或者直接按下面的手动做法补 bundle。

<details>
<summary>手动等价做法（不用 CLI）</summary>

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

</details>

### 从本地克隆安装

开发时用 `link:` 更顺手，改完代码刷新页面就生效，不用重新装包：

```bash
dsh plugin --profile <你的 profile> add link:/绝对路径/dsh-edit-retry
```

bundle 登记同上 —— `dsh plugin` 会自动做，手动做法见上面的折叠块。

## 行为与边界

- **右键是唯一入口。** 没有重试按钮，也没有双击 —— 按钮得挤进 DSH 自带的操作栏（复制 + 时间），而那一行渲染在自带组件内部，从外面接不进去；双击则会和浏览器「选中一个词」的手势打架。
- **只处理纯文本消息。** 带附件的消息没法当文本重发，因此保留浏览器原生右键菜单。
- **消息内的交互元素**（链接、按钮、输入框）保留它们自己的右键菜单，插件不会抢占。
- **消息为空白时「重试」置灰** —— 重发一个空提示词没有意义；「编辑并重试」仍然可用，它也是给这种消息补上文本的唯一途径。
- **第一条消息**走「新建会话」而不是「分叉」。理由见下面的注释；简单说，在 Turn 1 内部切分会留下一个空的「用时 N 秒」行，而在 Turn 1 之前切分会让子会话重发原文。第一条之外的消息才做分叉，并且切到**上一个已闭合的 turn 末尾**（中途插话的消息、以及上一个 turn 结束时 inbox 里还压着未取走提示词的情况除外，见上文）。
- **两条菜单项共用同一套分叉规则** —— 是消息的位置决定走新建还是分叉，跟选了哪一项无关。
- **重试跑在源会话当前选中的模型上**，而不是被重试那条消息当时用的模型；路由不可用时退回前缀继承的那个，重试本身不受影响。
- **重试会话会落在和源会话相同的 Workspace 分组里**，不会掉进 Ungrouped。
- **删除开关对两条路径都生效**，并且只在重试已经交给宿主之后才执行；重试本身失败不会删源会话。
- **中英文跟随 DSH 的语言设置**，读的是 `locale` 服务的实时快照。

## 它是怎么实现的

- **用一个下层优先级的槽位遮蔽自带渲染器。** DSH 自带的 `conversation.chat.node` 里 `user` 这一格注册在默认优先级 `0`。本插件用**同一个 key、优先级 `-1`** 注册：渲染器按优先级取每一格的第一个未被让位的条目，所以更小的数字会遮蔽自带的那条。随后插件通过 `ctx.slots.entries()` 取出**自带组件本身**来渲染，因此气泡样式、图片渲染、复制和时间戳仍然归产品所有。
- **必须转发 `locale` 座位。** `entry.locale` 是渲染器注入 `t` 翻译函数的依据，自带气泡的操作栏会调用 `t`；只转发 props 而不给这个座位会让自带节点崩溃。
- **客户端半边只 import React。** 默认的 Client 半边不允许引入任何 Harness Client 包（也就没有 JSX、没有 `react-dom`），所以菜单和编辑器全部用朴素元素加 `--dsw-*` 主题 token 画出来，因而自动跟随明暗主题。
- **宿主半边是给删除用的。** `sessions.fork`、`uiWorkspace.openSession`、`session.prompt` 都在客户端服务上，所以重试本身不需要宿主；宿主这边除了让客户端模块扫描发现这个包（并发出 `exports["./client"]`），还注册了那条删除路由。客户端和宿主是两个不共享 import 的模块图，**路由和请求头在两处各写了一遍**，自检里有一条专门断言这两种写法一致 —— 否则这个功能会永远静默 404。
- **模型的搬运在客户端完成，但落点在宿主。** 选择从会话的 `modelSelection` 投影读（客户端上就有一份，和 UI 显示的是同一帧），写则要走宿主那条 `session/selectModel`，因为模型的归属在宿主：只有它能给会话追加 `model/selection` 事件。这一路是**能力探测**式的 —— 探测不到 Remote 命名空间就只少这一项功能，菜单和重试照旧。

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
- **Which model the retry runs on: the one you have selected now.** Two DSH rules combine into a surprise here — a fork inherits only the event *prefix* up to the retry point, and a Host resolves a session's model from that session's *own* log (its last `request/header` route, or an unconsumed `model/selection`). So the most natural flow, switching models and then retrying an older message, used to run the child on the model that older turn happened to use. The retry therefore reads the source's `modelSelection` projection — exactly what the composer shows — and installs it on the child through the same `session/selectModel` RPC the composer's model control submits through, before the child's first prompt. When the child already resolves to the same route nothing is written; when the route is gone (or the session is held by another writer) the retry is still sent and only a console warning is left behind. One consequence worth knowing: the Host treats that RPC like a manual pick and also saves the selection as the deployment default.
- **Install:** `dsh plugin --profile <profile> add github:huangmiuXyz/dsh-edit-retry`, then restart DSH. The CLI forwards to pnpm in the profile directory and registers the bundle entry for you. The bare name does not resolve yet — the package is not on npm — and the Desktop app's own profile (`--profile desktop`) refuses the CLI, so install it there through the in-app plugin manager instead.
- **Two entries:** *Retry* resends the text untouched; *Edit and retry* opens an editor first. Both share one fork rule and one resend path, so only the text differs. Because the menu closes on click, the operation reports progress and failure in a status line under the bubble.
- **Deleting the source is opt-in and permanent.** DSH gives client plugins no way to delete a session — the workspace surface only archives, and the session store has no public remove API — so the delete lives in the **host half** and is reached over an HTTP route the host registers. It force-stops the agent, flushes, detaches the live entry, removes the on-disk log in both id spellings, *confirms it is gone*, and only then clears the workspace and projection accounting, because a half-deleted session is worse than an undeleted one. It runs only after the retry actually got in flight: a failed retry leaves the source alone. The route requires a custom header, which is what forces a CORS preflight and keeps other pages out, and session ids are charset-validated and path-containment-checked before touching the filesystem.
- **Boundaries:** text-only messages are retryable (attachments keep the native menu); right-click is the only entry point; interactive descendants keep their own context menu; blank text disables *Retry* while *Edit and retry* stays available; the first human prompt opens a fresh session while later prompts fork at the previous turn's **closed** boundary — a message injected mid-turn keeps its predecessor, because cutting earlier would drop messages the caller can still see; the retry adopts the source's currently selected model and falls back to the inherited one if that route is unavailable.
- **Caveat:** the delete walks into DSH internals (`sessions.store` / `detachEntered` / `storageDomain` shapes / the on-disk layout). Every step is feature-probed, so an upgrade degrades this to a refused or partial delete rather than a crash — but it can break. Also, the sidebar row for a deleted session may linger until the next reload; DSH exposes no client-side refresh, and reloading the page would interrupt the retry that was just sent.
- **How:** the plugin shadows the shipped `user` chat node at priority `-1` and renders the shipped component through `ctx.slots.entries()`, forwarding its `locale` seat so the shipped bubble keeps its `t`. The client half imports nothing but React.
- **Test:** `node test/check.mjs` — dependency-free offline self-check. The delete half runs against a real temporary `DSH_HOME`, so the filesystem behaviour under test is the real one.
