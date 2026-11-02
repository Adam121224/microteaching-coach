"use strict";
// 微格师范生试讲陪练工作台 —— 后端服务
// 单端口 HTTP 服务：托管前端静态文件 + 两个 AI 接口（课堂角色扮演 / 量表诊断）
// 大模型接入：OpenAI 兼容接口，通过环境变量配置（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）
// 访问控制：可配置 APP_PASSCODE 作为「登录」口令

const http = require("http");
const fs = require("fs");
const path = require("path");

// 简易 .env 加载（无需第三方依赖）—— 仅当系统环境变量未设置时才用 .env 覆盖
try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    }
  }
} catch (e) {}

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const PASSCODE = process.env.APP_PASSCODE || "";
const LLM_BASE_URL = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";

// 评分标准知识库（附件2 决赛评分表 + 学科核心素养 + 课程方案总要求）
const STANDARDS = (() => {
  try {
    const f = path.join(__dirname, "standards.json");
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {}
  return null;
})();
// 学科别名 → 知识库 key
const SUBJECT_ALIAS = {
  "政治": "道德与法治", "思政": "道德与法治", "思想品德": "道德与法治",
  "生物": "生物学", "信息": "信息科技", "信息技术": "信息科技",
  "体育": "体育与健康", "美术": "艺术", "音乐": "艺术",
  "外语": "英语", "史": "历史", "地": "地理", "物": "物理", "化": "化学",
  "数": "数学", "语": "语文", "劳": "劳动", "俄": "俄语", "日": "日语", "科": "科学"
};
function resolveSubject(gradeSubject) {
  const g = (gradeSubject || "");
  if (!g) return null;
  // 先精确匹配知识库 key
  if (STANDARDS && STANDARDS.coreLiteracy) {
    for (const k of Object.keys(STANDARDS.coreLiteracy)) if (g.indexOf(k) >= 0) return k;
  }
  for (const [alias, key] of Object.entries(SUBJECT_ALIAS)) if (g.indexOf(alias) >= 0) return key;
  return null;
}

/* ---------------- 大模型调用 ---------------- */
async function callLLM(systemPrompt, userPrompt) {
  if (!LLM_API_KEY) return null; // 未配置密钥，交由调用方走演示兜底
  const url = LLM_BASE_URL + "/chat/completions";
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + LLM_API_KEY },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0.9,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    })
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error("LLM_HTTP_" + resp.status + " " + t.slice(0, 300));
  }
  const data = await resp.json();
  return (data.choices && data.choices[0] && data.choices[0].message.content) || "";
}

function extractJSON(text) {
  if (!text) return null;
  let s = text.trim();
  // 去除 ```json ... ``` 代码围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  try { return JSON.parse(s); } catch (e) { return null; }
}

/* ---------------- 提示词 ---------------- */
const DIRECTOR_SYSTEM = `你是"微格AI陪练官"的课堂导演。你通过扮演四名学情各异的学生，模拟一个真实、有起承转合的中文课堂，对师范生的试讲做出真实反应。四名学生的年龄与认知水平由下方【学段画像】决定，必须严格贴合，不要套用固定年龄段（如一律写成高中生）。

四名学生人格（角色差异与学段无关，始终保留）：
- 小宇（学困生）：基础薄弱、注意力短、爱走神。前期常说"老师我还是不懂……"，听不懂就直说；若老师反复讲解、到了课中后段，他可以在某次讲解后说"老师，我好像懂了……"（但依然带点不确定）。
- 子涵（优等生·班长）：基础好、超前、爱抢答、会追问，偶尔纠正老师口误。前期最活跃，后期可在老师引导下做小结。
- 浩然（调皮生）：聪明但坐不住。前期爱起哄、跑题；但若老师表现出不满、点名批评他（尤其被批评两次及以上），他必须明显收敛、安静下来、不再闹，被点名才答、声音收敛。
- 思琪（沉默生）：听得懂但从不动手举手、怕答错。只有被点名才说话，声音很小，答完加一句"……是吗？"；课中后段偶尔能小声接上一句。

铁律：
1. 你只输出学生说的话，绝不替老师讲课、绝评价老师、绝不描写环境。
2. 老师若明确点名某学生（action=call:<key>），该学生必须回应。
3. 否则根据老师最新一段话与"课堂状态"，决定 0、1 或最多 2 名学生自然反应：
   - 内容偏难/抽象/公式推导 → 小宇说不懂
   - 提问且有人举手 → 子涵抢答
   - 提问但无人举手 → 子涵追问 或 浩然起哄
   - 内容有趣/生活化/讲故事 → 浩然跑题
   - 老师长时间自顾自讲、无提问无点名 → 多数情况沉默（返回空数组）
4. 一堂真实的课有节奏：开场（导入）大家拘谨、少回应；中段（新授/练习）最活跃、提问多；后段（小结）因听懂而踏实、回应变稳。不要每回合都有人说话，冷场仍真实存在。
5. 学习成长：系统会传入每个学生的"理解度(0-100)"。理解度低→说不懂；理解度升到约 65 以上且该生本堂课还没表达过"懂了"→可让其说"我懂了/好像懂了"（小宇尤其要有这种突破时刻，体现"教会了她们"）。
6. 感知老师情绪：系统会传入 teacherDispleasure（老师不满累计次数）与每个学生的被批评次数。当 teacherDispleasure 较高，或某学生被批评≥2 次，该生（尤其浩然）必须收敛、安静、认真对待；全班在被批评后几回合内也更规矩、更认真。
7. 每人发言限 1-2 句，口语化、符合【学段画像】中的年龄与身份。
8. 只输出如下 JSON，不要任何额外文字：
{"responses":[{"student":"xiaoyu|zihan|haoran|siqi","text":"..."}]}
若无学生反应，返回 {"responses":[]}。`;

function buildChatUser(ctx) {
  const lines = (ctx.context || []).slice(-10).map(e => {
    if (e.kind === "teacher") return "老师：" + e.text;
    if (e.kind === "student") return (e.name || "学生") + "：" + e.text;
    return "（" + e.text + "）";
  });
  let head = `【课堂场景】地区：${ctx.scenario.region}；学段学科：${ctx.scenario.gradeSubject || "未指定"}；班级：${ctx.scenario.classType}。\n`;
  // ---- 注入学段画像：决定学生年龄/思维/课前储备/答错率/提问深度/对师反应，杜绝"各学段水平一样" ----
  if (ctx.scenario && ctx.scenario.gradeProfile) {
    const gp = ctx.scenario.gradeProfile;
    head += `【学段画像】这是${gp.label}阶段的学生（典型年龄约${gp.ageNum}岁）。\n`
      + `· 思维特征：${gp.thinking}\n`
      + `· 课前知识储备：${gp.pre}\n`
      + `· 答错/答不上来的常态：${gp.wrong}\n`
      + `· 对老师的反应：${gp.react}\n`
      + `· 提问深度：${gp.qdepth}\n`
      + `· 典型发言：${gp.examples}\n`
      + `请严格让四名学生的发言、提问、答错/答不出的表现符合该学段年龄与认知水平，绝不能出现跨学段违和（如把小学生写成高中生水平，或把高中生写成小学生口吻）。学生课前基本没有本课知识储备，大多是老师讲到才慢慢学会；不一定每题都能答对，答错或答不出应视为正常真实反应。课堂节奏仍遵循：导入拘谨、新授活跃、小结踏实。`;
  }
  if (ctx.pptPage) head += `【当前 PPT 页码】第 ${ctx.pptPage} 页（仅页码，学生仅知老师讲到对应页，不得预知幻灯片内容）。\n`;
  head += `【最近课堂记录】\n${lines.join("\n") || "（暂无）"}\n`;
  if (ctx.action && ctx.action.startsWith("call:")) {
    const map = { xiaoyu: "小宇", zihan: "子涵", haoran: "浩然", siqi: "思琪" };
    const name = map[ctx.action.split(":")[1]] || "某学生";
    head += `\n【当前动作】老师点名了「${name}」，请让${name}回应（可结合上面的提问作答）。只返回该学生的话。`;
  } else {
    head += `\n【当前动作】老师发了一段话（${ctx.raiseHand ? "此时有学生举手" : "此时无人举手"}）：\n"${ctx.teacherText || ""}"\n请判断哪些学生会自然反应，返回 JSON。`;
  }
  // ---- 注入跨回合课堂状态：让学生表现出"成长"与"感知老师情绪" ----
  if (ctx.classState) {
    const cs = ctx.classState;
    const t = cs.lessonTurn || 1;
    let phase = "导入（开场，学生拘谨、少回应）";
    if (t > 3 && t <= 12) phase = "新授（中段，最活跃、提问多）";
    else if (t > 12 && t <= 20) phase = "练习（学生尝试运用）";
    else if (t > 20) phase = "小结（后段，学生渐踏实、因听懂而稳）";
    const NAME = { xiaoyu: "小宇", zihan: "子涵", haoran: "浩然", siqi: "思琪" };
    const stuLines = Object.keys(NAME).map(k => {
      const v = cs.students[k] || {};
      const rep = (v.reprimands > 0) ? `，被老师批评 ${v.reprimands} 次${v.reprimands >= 2 ? "（已≥2次，须明显收敛）" : ""}` : "";
      const got = v.gotIt ? "，已表达过理解" : "";
      return `${NAME[k]}：理解度 ${v.understanding || 0}${rep}${got}`;
    }).join("；");
    const mood = (cs.lastReprimandKey && cs.lastReprimandTurn)
      ? `；最近在第 ${cs.lastReprimandTurn} 回合批评了 ${NAME[cs.lastReprimandKey] || cs.lastReprimandKey}${(t - cs.lastReprimandTurn) <= 3 ? "（近几回合内，全班应更规矩）" : ""}`
      : "；近期无批评，课堂氛围正常";
    head += `\n【课堂状态】第 ${t} 个老师回合，阶段：${phase}；老师不满累计 ${cs.teacherDispleasure || 0} 次${mood}。\n【学生成长/情绪状态】${stuLines}。\n请结合以上状态，让学生的反应体现"从不懂到懂"的成长，并在老师不满/批评后让学生（尤其浩然）收敛、全班更认真。`;
  }
  return head;
}

const RESEARCHER_SYSTEM = `你是微格教学的资深教研员（陈研之）。请依据以下权威标准对师范生试讲做专业诊断：
【标准A】附件2《师范生技能大赛决赛评分表》维度与权重：教学设计(20分)、说课(20分)、教学技能(40分)、教学反思(20分)。
【标准B】所选学科的《义务教育XX课程标准（2022年版）》"核心素养 / 学业质量 / 评价建议"（下方【该学科课标要点】会给出该学科的核心素养）。
诊断须严格对照上述标准，紧扣附件2细则与该学科核心素养，评语具体、可操作、有建设性，避免空话。

【关于"模糊概念"的硬性要求】对于"普通话 / 口语表达 / 教态气质"这类容易流于主观的维度，严禁以"无法评判 / 没法评判 / 缺少依据"等搪塞。必须依据下方【语音特征】中的语速数据，并结合逐字稿的语言逻辑性、连贯性、条理性，给出有事实依据的基础结论。例如：语速 X 字/分钟（偏快 / 适中 / 偏慢），表达是否清晰流畅、有无逻辑跳跃或口头禅过多；即便信息有限，也要基于已有数据给出"倾向性结论 + 改进方向"，绝不说"无法评价"。

请按下面 5 个维度各打 0–20 分（"教学技能"40分拆为"教学实施与师生互动""教学方法与教师素养"两项各20，合计仍对应附件2的40分权重），总分100。只输出 JSON，不要额外文字：
{
  "rubric":[
    {"name":"教学设计","score":0-20,"comment":"对照附件2教学设计细则：重点难点分析、内容完整、符合学情、情境创设；若提供教案须结合教案评"},
    {"name":"说课（教学表达）","score":0-20,"comment":"对照附件2说课细则：普通话（须结合【语音特征】语速与逐字稿逻辑给结论，禁说'无法评判'）、表达流畅、重难点清楚、符合课标与学情、无知识性错误"},
    {"name":"教学实施与师生互动","score":0-20,"comment":"来自附件2教学技能：师生互动、任务完成、学生主体性、课改理念、过程性评价"},
    {"name":"教学方法与教师素养","score":0-20,"comment":"来自附件2教学技能：方法灵活、教态自然、演示规范、职业精神"},
    {"name":"教学反思","score":0-20,"comment":"对照附件2教学反思；并结合【师范生课后自评】质量：若已提交自评，依据其反思的准确度/深刻度/可行动性评分；若未提交，本维度明显偏弱并提示'未体现反思'"}
  ],
  "total": 数字(0-100),
  "curriculum":{"covered":["已在本课体现的课标核心素养/学业质量要求"],"missing":["未体现或薄弱的"],"comment":"结合【该学科课标要点】说明覆盖情况"},
  "selfReflect":{
    "used": true或false,
    "teacherSaid":"复述师范生自评要点（未提交则为空字符串）",
    "eval":"对师范生自我反思质量的评价：是否准确诊断自身问题、是否深刻、是否提出可行动的改进",
    "note":"若已提交：给出针对性评价并说明对'教学反思'维度的影响；若未提交：明确写明'师范生未提交课后自评，未体现反思意识，教学反思维度按弱项处理'"
  },
  "overall":["建议1","建议2","建议3"]
}
若提供了"教案文本"，请额外评估备课充分度，并在 JSON 中增加字段（未提供则 prep 为 null）：
"prep":{"score":0-20,"comment":"...","aspects":{"目标清晰度":0-5,"重难点把握":0-5,"活动设计":0-5,"时间分配":0-5}}
备课评测关注：教学目标是否清晰可测、重难点是否把握准确、活动设计是否支撑目标、时间分配是否合理。`;

function buildScoreUser(p) {
  let s = `【场景】地区：${p.scenario.region}；学段学科：${p.scenario.gradeSubject || "未指定"}；班级：${p.scenario.classType}。\n`;
  const subjKey = resolveSubject(p.scenario.gradeSubject);
  // ---- 注入评分标准知识库：附件2 + 学科核心素养 + 课程方案总要求 ----
  if (STANDARDS) {
    s += `\n【评分标准·附件2决赛评分表全文】\n${STANDARDS.attachment2 || "(无)"}\n`;
    if (subjKey && STANDARDS.coreLiteracy && STANDARDS.coreLiteracy[subjKey]) {
      s += `\n【该学科课标要点·${subjKey}】${STANDARDS.coreLiteracy[subjKey]}\n（诊断时须对照上述核心素养，评价本课是否落实、覆盖情况如何）\n`;
    } else {
      s += `\n【课程方案总要求】${STANDARDS.general || ""}\n（未识别到具体学科，请按通用核心素养导向评价）\n`;
    }
    if (STANDARDS.keyFocus) s += `\n【评价设计参考框架（含核心素养/学业质量/教学与评价建议范式）】\n${STANDARDS.keyFocus.slice(0, 1500)}\n`;
  }
  s += `\n【课堂互动数据】提问次数：${p.stats.questionsCount}；点名总次数：${p.stats.roll.total}（举手${p.stats.roll.raised}/不举手${p.stats.roll.notRaised}/走神${p.stats.roll.distracted}）；冷场走神次数：${p.stats.distractedMoments}。\n`;
  s += `【教师自评课标覆盖】已勾选：${(p.covered && p.covered.length) ? p.covered.join("、") : "无"}。\n`;
  s += `【试讲逐字稿】\n${p.transcript && p.transcript.trim() ? p.transcript : "（教师未提供逐字稿，请仅依据互动数据与课标标准给出诊断建议）"}`;
  if (p.lessonPlan && p.lessonPlan.text && p.lessonPlan.text.trim()) {
    s += `\n【教师上传教案】文件名：${p.lessonPlan.name || "教案"}\n${p.lessonPlan.text.trim().slice(0, 4000)}`;
  }
  // ---- 注入语音特征：语速（字/分钟）由前端累计识别字数 / 有效发言时长估算 ----
  if (p.voice && p.voice.speakingMs && p.voice.speakingMs > 0) {
    const cpm = Math.round(p.voice.chars / (p.voice.speakingMs / 60000));
    s += `\n【语音特征·语速】本次试讲语音识别累计有效发言时长约 ${Math.round(p.voice.speakingMs / 1000)} 秒，识别字数约 ${p.voice.chars} 字，估算语速约 ${cpm} 字/分钟（正常授课语速参考区间约 180–260 字/分钟；偏快易吞字、偏慢易拖沓）。请据此对"说课·教学表达"中的普通话语速、表达流畅度给出有依据的结论，严禁以"无法评判/没法评判"搪塞。\n`;
  } else {
    s += `\n【语音特征·语速】未采集到有效语音时长（师范生可能以键盘输入为主、未启用语音识别）。请尽可能依据逐字稿的语言逻辑与连贯性，对表达维度给出倾向性结论，仍不得直接以"无法评判"搪塞。\n`;
  }
  // ---- 注入师范生课后自评（反思评分依据） ----
  if (p.selfReflect && String(p.selfReflect).trim()) {
    s += `\n【师范生课后自评】师范生在课程结束后主动提交了自我反思：\n"${String(p.selfReflect).trim()}"\n请据此评价其反思准确度、深刻度与可行动性，并将此作为"教学反思"维度评分的重要依据（未提交则显示未体现反思）。\n`;
  } else {
    s += `\n【师范生课后自评】师范生未提交课后自评。请在"教学反思"维度按"未体现反思意识"处理，并在 overall 中提示其应养成课后自我诊断的习惯。\n`;
  }
  return s;
}

/* ---------------- 演示兜底（无密钥时） ---------------- */
const DEMO_RESP = {
  xiaoyu: "老师，我还是不懂……",
  zihan: "老师，我来！我觉得应该是……（说出思路）",
  haoran: "哈哈，老师这个我知道！",
  siqi: "（小声）……是这个意思吗？"
};
function demoChat(ctx) {
  if (ctx.action && ctx.action.startsWith("call:")) {
    const k = ctx.action.split(":")[1];
    let txt = DEMO_RESP[k] || "……";
    const cs = ctx.classState;
    if (cs && cs.students[k] && cs.students[k].reprimands >= 2 && k === "haoran") txt = "（坐得端正的）老师，我……我认真听。";
    return { demo: true, responses: [{ student: k, text: txt }] };
  }
  const t = ctx.teacherText || "";
  const isQ = /[?？]|为什么|怎么|想想|谁能|谁来|说说看/.test(t);
  const isHard = t.length > 60 || /公式|定理|推导|抽象|复杂|难|计算|证明/.test(t);
  const isFun = /游戏|故事|比赛|动画|生活|例子|视频|图片/.test(t);
  const cs = ctx.classState;
  let r = [];
  // 学习成长：小宇理解度够高且未表达过 → 说"懂了"
  if (cs && cs.students.xiaoyu.understanding >= 65 && !cs.students.xiaoyu.gotIt) {
    r.push({ student: "xiaoyu", text: "老师，我好像……懂了？" });
  }
  // 被批评两次后浩然收敛，不再主动起哄
  const haoranCalm = cs && cs.students.haoran.reprimands >= 2;
  if (r.length === 0) {
    if (isHard && !haoranCalm) r.push({ student: "xiaoyu", text: DEMO_RESP.xiaoyu });
    else if (isQ) r.push({ student: ctx.raiseHand ? "zihan" : (haoranCalm ? "zihan" : "haoran"), text: ctx.raiseHand ? DEMO_RESP.zihan : (haoranCalm ? "（安静思考）老师，我来试试。" : DEMO_RESP.haoran) });
    else if (isFun && !haoranCalm) r.push({ student: "haoran", text: "老师，讲个故事呗～（演示占位）" });
  }
  return { demo: true, responses: r.slice(0, 2) };
}
function demoScore(p) {
  const engaged = Math.min(4, p.stats.roll.total);
  const subjKey = resolveSubject(p.scenario.gradeSubject);
  return {
    demo: true,
    rubric: [
      { name: "教学设计", score: p.lessonPlan && p.lessonPlan.text ? 16 : 10, comment: "（演示占位）请配置大模型以依据附件2与课标真实评分。" },
      { name: "说课（教学表达）", score: p.scenario.gradeSubject ? 15 : 10, comment: "（演示占位）表达清晰度、重难点阐述待评。" },
      { name: "教学实施与师生互动", score: Math.min(20, p.stats.questionsCount * 3 + p.stats.roll.total * 1.5), comment: "（演示占位）建议结合真实互动质量自评。" },
      { name: "教学方法与教师素养", score: Math.max(6, 16 - p.stats.distractedMoments * 3), comment: "（演示占位）方法灵活度、教态待评。" },
      { name: "教学反思", score: Math.max(6, 14 - p.stats.distractedMoments * 2), comment: "（演示占位）目标达成审视、改进策略待评。" }
    ],
    total: 0,
    curriculum: { covered: p.covered || [], missing: subjKey ? ["（演示占位）请配置大模型以对照《义务教育" + subjKey + "课程标准》核查"] : [], comment: "（演示占位）请配置大模型以获得真实课标核查。" },
    selfReflect: {
      used: !!(p.selfReflect && String(p.selfReflect).trim()),
      teacherSaid: p.selfReflect || "",
      eval: "（演示占位）配置大模型后，将依据师范生自评质量评价其反思深度，并计入教学反思维度。",
      note: (p.selfReflect && String(p.selfReflect).trim()) ? "" : "师范生未提交课后自评，未体现反思意识。"
    },
    overall: ["（演示模式）配置 LLM_API_KEY 后生成基于附件2与学科课标的真实诊断。"]
  };
}

/* ---------------- 教案/PPT 文本与页数提取（上传文件 → 文字 / 页数） ---------------- */
// 返回 { text, pages }。PPT 仅取页数（不抽取幻灯片文字，避免向 AI 预泄内容）。
// 加载 jszip：优先用 npm 安装的常规依赖（Render 等平台构建时自动安装），
// 若未安装则回退到随项目打包的 vendor 副本（保证离线/无网环境也能解析 docx/pptx）。
let _JSZip = null;
function getJSZip() {
  if (_JSZip) return _JSZip;
  let lib = null;
  try { lib = require("jszip"); } catch (e) { /* npm 依赖不存在，尝试 vendored 副本 */ }
  if (!lib) { try { lib = require("./vendor/jszip.min.js"); } catch (e) { /* 两者都无 */ } }
  if (!lib) throw new Error("服务器未安装解析库（jszip），请联系部署者或改用 .txt 上传");
  _JSZip = lib;
  return lib;
}

async function extractText(filename, buf) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (["txt", "md", "text", "csv"].includes(ext)) return { text: buf.toString("utf8"), pages: 0 };
  if (ext === "docx") {
    const JSZip = getJSZip();
    const zip = await JSZip.loadAsync(buf);
    const doc = zip.file("word/document.xml");
    if (!doc) return { text: "", pages: 0 };
    const xml = await doc.async("string");
    const text = xml
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
      .replace(/\s+/g, " ").trim();
    return { text, pages: 0 };
  }
  if (ext === "pdf") {
    // 不依赖外部库：按原始字节统计页面对象（压缩页面树场景下可能为 0，属可接受降级）
    const s = buf.toString("latin1");
    const m = s.match(/\/Type\s*\/Page(?![s])/g);
    return { text: "", pages: m ? m.length : 0 };
  }
  if (ext === "pptx") {
    const JSZip = getJSZip();
    const zip = await JSZip.loadAsync(buf);
    const slides = Object.keys(zip.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/i.test(f));
    return { text: "", pages: slides.length }; // 仅返回页数，不预泄幻灯片内容
  }
  throw new Error("不支持的文件类型：." + ext + "（支持 .txt/.md/.docx/.pdf/.pptx）");
}

/* ---------------- HTTP 处理 ---------------- */
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}
function checkPasscode(req) {
  if (!PASSCODE) return true;
  const h = req.headers["x-passcode"] || "";
  return h === PASSCODE;
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, ""));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("404 Not Found"); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split("?")[0];

    if (req.method === "GET" && url === "/api/status") {
      return sendJSON(res, 200, { ok: true, needsPasscode: !!PASSCODE, hasLLM: !!LLM_API_KEY });
    }

    if (req.method === "POST" && (url === "/api/chat" || url === "/api/score")) {
      if (!checkPasscode(req)) return sendJSON(res, 401, { error: "需要口令（登录）" });
      let body = "";
      for await (const chunk of req) body += chunk;
      let payload;
      try { payload = JSON.parse(body); } catch (e) { return sendJSON(res, 400, { error: "无效请求体" }); }

      if (url === "/api/chat") {
        const result = await callLLM(DIRECTOR_SYSTEM, buildChatUser(payload));
        if (result === null) return sendJSON(res, 200, demoChat(payload));
        const parsed = extractJSON(result);
        if (!parsed || !Array.isArray(parsed.responses)) return sendJSON(res, 200, demoChat(payload));
        return sendJSON(res, 200, { demo: false, responses: parsed.responses.slice(0, 2) });
      }

      if (url === "/api/score") {
        const result = await callLLM(RESEARCHER_SYSTEM, buildScoreUser(payload));
        if (result === null) return sendJSON(res, 200, demoScore(payload));
        const parsed = extractJSON(result);
        if (!parsed || !Array.isArray(parsed.rubric)) return sendJSON(res, 200, demoScore(payload));
        parsed.demo = false;
        parsed.total = parsed.total || parsed.rubric.reduce((a, b) => a + (b.score || 0), 0);
        return sendJSON(res, 200, parsed);
      }
    }

    if (req.method === "POST" && url === "/api/extract") {
      if (!checkPasscode(req)) return sendJSON(res, 401, { error: "需要口令（登录）" });
      let body = "";
      for await (const chunk of req) body += chunk;
      let p;
      try { p = JSON.parse(body); } catch (e) { return sendJSON(res, 400, { error: "无效请求体" }); }
      try {
        if (!p.data) throw new Error("缺少文件数据");
        const buf = Buffer.from(p.data, "base64");
        if (buf.length > 8 * 1024 * 1024) throw new Error("文件过大（>8MB）");
        const res2 = await extractText(p.filename || "a.txt", buf);
        const text = res2.text || "";
        return sendJSON(res, 200, { ok: true, text: text.slice(0, 20000), charCount: text.length, pages: res2.pages || 0, filename: p.filename });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: String((e && e.message) || e) });
      }
    }

    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
    res.writeHead(405); res.end("method not allowed");
  } catch (e) {
    sendJSON(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("微格试讲陪练工作台已启动： http://0.0.0.0:" + PORT);
  console.log("大模型：" + (LLM_API_KEY ? LLM_MODEL + " @ " + LLM_BASE_URL : "未配置（演示兜底模式）"));
  if (PASSCODE) console.log("访问控制：已启用口令登录");
});
