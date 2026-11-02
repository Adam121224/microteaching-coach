# 部署到 Render（免费托管）

> 目标：拿到一个公网可访问的链接，评委直接打开就能用，不依赖 WorkBuddy 平台。
> 全程只需你点几下 + 复制粘贴，不需要写代码。

---

## 一、前置：把项目推到 GitHub

Render 只能从 Git 仓库部署（不能直接上传本地文件夹），所以先建一个仓库。

1. 打开 https://github.com/new ，新建仓库，名字随意（如 `microteaching-coach`），
   选 **Private（私有）** 或 Public 都可以，**不要**勾选自动添加 README。
2. 在本项目目录执行以下命令（把 `<你的仓库地址>` 换成上一步生成的地址）：

```bash
cd "C:/Users/Panasonic/WorkBuddy/2026-10-29-12-06-23/microteaching-coach"
git init
git add .
git commit -m "deploy: microteaching coach"
git branch -M main
git remote add origin <你的仓库地址>
git push -u origin main
```

> ✅ `.gitignore` 已排除 `.env` 和 `node_modules`，**API Key 不会被推上去**，安全。

---

## 二、在 Render 部署

1. 注册/登录 https://render.com （可用 GitHub 账号直接登录，免注册）。
2. 首页点 **New +** → 选择 **Blueprint**（会自动读取项目里的 `render.yaml`）。
3. 选中你刚才的 GitHub 仓库 → 点 **Connect**。
4. Render 会列出 `microteaching-coach` 服务，点 **Apply / Create**。

> 如果找不到 Blueprint 入口，也可用 **New + → Web Service**，然后手动填：
> - Runtime: `Node`
> - Build Command: `npm install`
> - Start Command: `node server.js`
> - Plan: `Free`

---

## 三、填写环境变量（关键，不填 AI 就没法用）

在服务页面左侧点 **Environment** → 添加以下变量：

| Key | Value |
|---|---|
| `LLM_BASE_URL` | `https://api.deepseek.com/v1` |
| `LLM_API_KEY` | `sk-89f1e361dd4acfb59ec42ca4e5b596fb`（你的 DeepSeek Key） |
| `LLM_MODEL` | `deepseek-chat` |
| `APP_PASSCODE` | **留空**（保持评委可直接打开） |

> 保存后 Render 会自动重新部署一次，约 1–3 分钟。

---

## 四、拿到链接

部署成功后，页面顶部会显示地址，形如：

```
https://microteaching-coach-xxxx.onrender.com
```

这个链接**直接可用、可直接转发**，没有 WorkBuddy 那套访问参数问题。

---

## 五、必须知道的免费版限制

| 限制 | 说明 | 应对 |
|---|---|---|
| **冷启动休眠** | 免费实例 15 分钟无人访问会休眠，**下次打开需等 30–60 秒**白屏加载 | 答辩/评审前**提前 5 分钟自己打开一次**唤醒；或答辩前一直留一个标签页 |
| **每月 750 小时** | 单实例免费额度，够用 | — |
| **重新部署** | 每次 push 到 GitHub 会自动重建 | — |

> ⚠️ **答辩前务必自己先打开一次确认能正常唤醒和对话**，不要把"第一次打开"留给评委。

---

## 六、排错

- **打开是 502 / 无响应**：等 30 秒再刷新（正在冷启动）。持续失败则看 Render 的 **Logs** 页。
- **页面能开但 AI 不回复**：检查 `LLM_API_KEY` 是否填对、DeepSeek 账户是否有余额。
- **上传 docx/pptx 报错**：Render 构建时会装 `jszip`；若失败，确认 `package.json` 的 `dependencies` 里有 `jszip`。
- **想改成"需口令"**：把 `APP_PASSCODE` 填一个口令值即可（但对评委不友好，建议保持为空）。

---

## 附：本次为部署做的改动

1. `server.js` — jszip 加载改为「优先 npm 依赖，回退到 `vendor/jszip.min.js`」，兼容标准构建与离线运行。
2. `render.yaml` — 新增，Render Blueprint 配置。
3. `package.json` — 规范了 `engines` 字段格式。
4. `vendor/jszip.min.js` — 保留，作为无网兜底（可删，不影响 Render 部署）。
