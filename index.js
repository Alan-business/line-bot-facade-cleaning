const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_API_ENDPOINT = process.env.NVIDIA_API_ENDPOINT || 'https://integrate.api.nvidia.com/v1/chat/completions';
const LLM_MODEL_NAME = process.env.LLM_MODEL_NAME || 'openai/gpt-oss-20b';

if (!NVIDIA_API_KEY) console.error('❌ Missing NVIDIA_API_KEY');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString(); } }));

const users = {};
let adminUserId = null;

const FAQ = [
  { q: 'Q1: 你們提供哪些清潔服務？', a: '我們提供房屋外觀清潔，包括外牆及窗戶清潔服務。' },
  { q: 'Q2: 服務範圍包括哪些地區？', a: '我們的服務範圍為中部地區。' },
  { q: 'Q3: 清潔費用如何計算？', a: '費用根據清洗範圍的平方公尺計算，每平方公尺 NT$ 500，請預約後我們會為您報價。' },
  { q: 'Q4: 清潔需要多長時間？', a: '根據面積而定，一面牆約需3-4小時。' },
  { q: 'Q5: 需要提前多久預約？', a: '建議提前2-3個禮拜預約，以確保排程。' },
  { q: 'Q6: 清潔時需要我在場嗎？', a: '建議您在場，以便確認清潔範圍與品質。' },
  { q: 'Q7: 你們有保險嗎？', a: '我們使用的清潔藥水都是中性配方，不會腐蝕牆面，安全有保障。' },
  { q: 'Q8: 支援哪些付款方式？', a: '我們支援現金或轉帳付款。' }
];

const MAIN_MENU = {
  type: 'template',
  altText: '主選單',
  template: {
    type: 'buttons',
    title: '煥然逸新 房屋外觀清潔',
    text: '請選擇服務：',
    actions: [
      { type: 'message', label: '📋 常見問題', text: '常見問題' },
      { type: 'message', label: '📅 預約清潔', text: '預約清潔' },
      { type: 'message', label: '📞 聯絡資訊', text: '聯絡資訊' },
      { type: 'message', label: '🤖 智能助手', text: '智能助手' }
    ]
  }
};

async function replyMessage(replyToken, message) {
  try {
    const messages = Array.isArray(message) ? message : [message];
    const res = await axios.post('https://api.line.me/v2/bot/message/reply', {
      replyToken, messages
    }, {
      headers: {
        'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log('✅ 回覆成功:', res.status);
  } catch (err) {
    console.error('❌ 回覆失敗:', err.message);
    throw err;
  }
}

async function pushMessage(userId, message) {
  try {
    const messages = Array.isArray(message) ? message : [message];
    const res = await axios.post('https://api.line.me/v2/bot/message/push', {
      to: userId, messages
    }, {
      headers: {
        'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log('✅ 推送成功:', res.status);
  } catch (err) {
    console.error('❌ 推送失敗:', err.message);
    throw err;
  }
}

async function callLLM(userMessage) {
  try {
    const res = await axios.post(
      NVIDIA_API_ENDPOINT,
      {
        model: LLM_MODEL_NAME,
        messages: [
          {
            role: 'system',
            content: `你是「煥然逸新 房屋外觀清潔公司」的智能客服助理。

═══════════════════════════════════════
📌 公司基本資訊 (Company Info)
═══════════════════════════════════════
- 公司名稱：煥然逸新 房屋外觀清潔
- 服務項目：外牆清潔、窗戶清潔、全棟清潔、定期保養服務
- 服務地區：中部地區（台中、彰化、南投）
- 計價方式：每平方公尺 NT$ 500
- 特殊加收：太髒、不好施工、卡垢污卡太深、原本牆壁有點髒掉 → 現場評估後加收
- 預約建議：提前2-3週預約，以確保排程
- 施工建議：建議客戶在場，確認清潔範圍與品質
- 清潔藥水：中性配方，不會腐蝕牆面或窗框，安全有保障
- 損壞處理：施工前會先與客戶共同檢查並確認外牆狀況，確認無疑慮後才會開始施工
- 付款方式：現金或轉帳

服務流程（重要）：
1. 客戶詢問/預約 → 我們安排專人聯絡
2. 派員工到現場檢查 → 評估牆壁狀況、面積、施工難度
3. 根據檢查結果報價 → 每平方公尺 NT$ 500，特殊狀況加收
4. 客戶同意報價後 → 開始施工清潔
⚠️ 注意：在現場檢查前，我們「無法」給出確切報價！只能說明計價方式。

════════════════════════════════════
🎯 客戶意圖識別 (Intent Recognition)
═══════════════════════════════════════

【情境1】客戶說「再看看」、「我再考慮看看」、「嗯，再想想」→ 表示暫時不需要
  回覆：「好的，歡迎您隨時聯絡我們！如果有任何問題或需要報價，都可以透過『預約清潔』與我們聯絡。祝您順心！」

【情境2】客戶說「謝謝」、「謝啦」、「感恩」、「不用了」、「OK」→ 表示結束對話
  回覆：「不客氣！期待為您服務，祝您有美好的一天！」

【情境3】客戶說「嗨」、「你好」、「在嗎」→ 打招呼
  回覆：「您好！我是煥然逸新的智能助理，很高興為您服務！請問有什麼我可以幫您的嗎？」

【情境4】客戶直接問問題（如「費用多少？」、「服務範圍？」）→ 直接回答，不要反問
  原則：先給答案，必要時補充說明，最後才問「還有其他問題嗎？」

【情境5】客戶表達擔憂（如「會不會壞掉？」、「安全嗎？」）→ 直接解釋保障，給予安心感
  原則：先同理客戶擔憂，再說明公司措施，最後給予信心

【情境6】客戶同時問多個問題 → 逐一回答，條列清楚

【情境7】客戶問非本公司業務的問題（如「怎麼裝冷氣？」）→ 禮貌婉拒
  回覆：「抱歉，我是煥然逸新的專屬客服助理，主要服務房屋外觀清潔相關問題。關於冷氣安裝，建議您聯絡相關專業廠商喔！」

【情境8】客戶態度不佳（如「你們是怎樣！」、「超不專業」、「垃圾服務」）→ 保持冷靜專業
  原則：
  - 不與客戶對嗆、不反駁、不情緒化
  - 先道歉同理：「非常抱歉讓您有不好的體驗，我們深感歉意。」
  - 再引導解決：「我們會請專人儘快與您聯絡，親自處理您的問題。」
  - 最後提供管道：「也可以透過『預約清潔』與我們聯絡。」
  禁忌：不說「您誤會了」、「請冷靜」、「不要這麼激動」→ 這會讓客戶更火大！

【情境9】問題太複雜/LLM不知道答案（如「如果牆壁是特殊石材怎麼辦？」、「可以同時做防水嗎？」）→ 交給人工
  回覆：「這個問題比較專業/特殊，我目前無法給出準確答覆。我們會請專人儘快與您聯絡，根據您的實際狀況提供專業建議！也可以透過『預約清潔』與我們聯絡。」
  原則：誠實承認不知道，不瞎掰答案，引導至人工服務

═════════════════════════════════════
💬 回覆風格指南 (Response Style)
═══════════════════════════════════════
- 語言：繁體中文（台灣用語），如需英文回答請用 English
- 語氣：友善、專業、不過度推銷、不強迫推銷
- 長度：簡潔明瞭，重點優先，避免過長回覆（50-150字為佳）
- 格式：重要資訊用emoji強調（💰費用、⏰時間、📍地區等）
- 禁忌：不使用简体中文、不說「請問您想了解哪方面？」這種廢話
- 面對客戶惡劣態度：保持冷靜、不受影響、不情緒化回覆
- 遇到不知道的問題：誠實說「不知道」，交給人工，不瞎編答案`

═════════════════════════════════════
📋 對話流程建議 (Conversation Flow)
═══════════════════════════════════════
1. 開場：客戶打招呼 → 問候 + 簡短介紹 + 詢問需求
2. 解答：客戶提問 → 直接回答 + 補充資訊 + 問「還有其他問題嗎？」
3. 引導：適當時機 → 溫和提醒「需要報價的話，可以透過『預約清潔』聯絡我們喔！」
4. 結束：客戶說再看看/謝謝 → 祝福語 + 開放聯絡管道
5. 無法回答：遇到太複雜/不知道的問題 → 誠實承認 + 引導「專人聯絡」或『預約清潔』
6. 客戶態度不佳：保持冷靜專業 → 不對嗆、不情緒化 → 引導人工處理

═══════════════════════════════════════
🎓 加值服務建議 (Upselling - 自然不打擾)
═══════════════════════════════════════
當客戶詢問外牆清潔時，可以自然地提及：
「我們也提供窗戶清潔和全棟清潔服務喔！如果需要定期保養，也有優惠方案，歡迎一併詢問～」

═══════════════════════════════════════
⚠️ 專業界線 (Professional Boundaries)
═══════════════════════════════════════
- 不回答：政治、宗教、醫療、法律、其他公司業務的問題
- 不承諾：確切清潔時間（需現場評估）、固定加收金額（需看現場狀況）
- 不批評：其他清潔公司
- 必須說：報價需預約後現場評估才會提供

═══════════════════════════════════════
📝 範例對話 (Few-Shot Examples)
═══════════════════════════════════════

範例1 - 客戶說「再看看」：
客戶：「再看看」
你：「好的，歡迎您隨時聯絡我們！如果有任何問題或需要報價，都可以透過『預約清潔』與我們聯絡。祝您順心！」

範例2 - 客戶直接問問題：
客戶：「費用怎麼算？」
你：「💰 費用根據清洗範圍的平方公尺計算，每平方公尺 NT$ 500。特殊情況（如太髒、不好施工、卡垢污卡太深）會加收費用，我們會在預約後現場評估為您報價。還有其他問題嗎？」

範例3 - 客戶表達擔憂：
客戶：「清潔會不會壞掉？」
你：「請放心！🛡️ 我們會在正式開始清潔前，先與您共同檢查並確認外牆狀況，確認無疑慮後才會開始施工。而且我們使用的清潔藥水都是中性配方，不會腐蝕牆面或窗框，安全有保障！」

範例4 - 客戶打招呼：
客戶：「嗨」
你：「您好！👋 我是煥然逸新的智能助理，很高興為您服務！請問有什麼我可以幫您的嗎？」

範例5 - 客戶說謝謝：
客戶：「謝謝你」
你：「不客氣！😊 期待為您服務，祝您有美好的一天！」

═══════════════════════════════════════
Do NOT use Simplified Chinese (简体中文). If user asks in English, reply in English professionally.
═══════════════════════════════════════`
          },
          { role: 'user', content: userMessage }
        ],
        max_tokens: 500,
        temperature: 0.7,
        stream: false
      },
      {
        headers: {
          'Authorization': `Bearer ${NVIDIA_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    // Truncate to LINE's 5000 character text limit
    // gpt-oss-20b is a reasoning model - response may be in reasoning_content or reasoning field
    const message = res.data.choices[0].message;
    const responseText = message.content || message.reasoning_content || message.reasoning || '无法获取回复';
    return responseText.trim().slice(0, 5000);
  } catch (err) {
    console.error('❌ LLM 调用失败:', {
      status: err.response?.status,
      statusText: err.response?.statusText,
      data: err.response?.data,
      message: err.message,
      url: NVIDIA_API_ENDPOINT,
      model: LLM_MODEL_NAME
    });
    return '智能助手暂时不可用，请稍后再试';
  }
}

async function replyWithMenuFirst(replyToken, messages) {
  // LINE allows up to 5 messages per reply
  const menuMessage = MAIN_MENU;
  const actualMessages = Array.isArray(messages) ? messages : [messages];
  const allMessages = [menuMessage, ...actualMessages].slice(0, 5);
  return replyMessage(replyToken, allMessages);
}

app.get('/webhook', (req, res) => { res.send('OK'); });

app.post('/webhook', (req, res) => {
  const signature = req.headers['x-line-signature'];
  const body = req.rawBody || JSON.stringify(req.body);

  if (!signature) return res.status(400).json({ error: 'Missing signature' });
  
  const hash = crypto.createHmac('sha256', CHANNEL_SECRET).update(body).digest('base64');
  if (hash !== signature) return res.status(401).json({ error: 'Invalid signature' });
  
  console.log('✅ Signature 驗證成功');
  if (!req.body.events || !Array.isArray(req.body.events)) return res.json({});
  
  Promise.all(req.body.events.map(event => handleEvent(event)))
    .then(() => res.json({}))
    .catch((err) => { console.error('❌ 處理事件錯誤:', err.message); res.status(500).end(); });
});

async function handleEvent(event) {
  try {
    if (event.type !== 'message' || event.message.type !== 'text') return;
    const userId = event.source.userId;
    const text = event.message.text.trim();
    const replyToken = event.replyToken;
    if (!adminUserId) adminUserId = userId;

    // Priority 1: Booking flow (never interrupt, no menu popup)
    if (users[userId] && users[userId].step === 'booking') {
      const booking = users[userId].data;
      if (!booking.name) { booking.name = text; return replyMessage(replyToken, { type: 'text', text: '請輸入您的電話號碼：' }); }
      if (!booking.phone) { booking.phone = text; return replyMessage(replyToken, { type: 'text', text: '請輸入清潔地址：' }); }
      if (!booking.address) { booking.address = text; return replyMessage(replyToken, { type: 'text', text: '請輸入需要清潔的位置（例如：外牆、窗戶、全棟等）：' }); }
      if (!booking.area) { booking.area = text; return replyMessage(replyToken, { type: 'text', text: '請輸入預計清潔日期（例如：2026/05/20）：' }); }
      if (!booking.date) {
        booking.date = text;
        booking.userId = userId;
        const summary = `📋 預約摘要\n姓名：${booking.name}\n電話：${booking.phone}\n地址：${booking.address}\n清潔位置：${booking.area}\n預計日期：${booking.date}`;
        
        await replyMessage(replyToken, {
          type: 'text',
          text: `${summary}\n\n✅ 預約已送出！我們會儘快透過LINE與您聯絡報價。\n輸入「主選單」返回。`
        });

        if (adminUserId && adminUserId !== userId) {
          await pushMessage(adminUserId, {
            type: 'text',
            text: `🔔 新預約通知\n${summary}\n\n請聯絡客戶報價！`
          });
        }

        delete users[userId];
        return;
      }
    }

    // Priority 2: 主選單 (no duplicate menu)
    if (text === '主選單' || text === 'menu') {
      users[userId] = { ...users[userId], step: 'menu', mode: 'default' };
      return replyMessage(replyToken, MAIN_MENU);
    }

    // Priority 3: 我的ID (menu first, then reply)
    const textLower = text.toLowerCase();
    if (textLower === '我的id' || textLower === 'my id' || text === '我的ID') {
      return replyWithMenuFirst(replyToken, { type: 'text', text: `你的User ID: ${userId}` });
    }

    // Priority 4: 常見問題 (menu first, then static FAQ)
    if (text === '常見問題' || text === 'FAQ') {
      let replyText = '📋 常見問題 (FAQ)\n\n';
      FAQ.forEach((item) => { replyText += `${item.q}\n${item.a}\n\n`; });
      replyText += '輸入「預約清潔」開始預約，或「主選單」返回。';
      return replyWithMenuFirst(replyToken, { type: 'text', text: replyText });
    }

    // Priority 5: 聯絡資訊 (menu first, then reply)
    if (text === '聯絡資訊') {
      return replyWithMenuFirst(replyToken, {
        type: 'text',
        text: '📞 煥然逸新 房屋外觀清潔公司\n服務地區：中部地區\n服務項目：外牆及窗戶清潔\n聯絡方式：請透過「預約清潔」與我們聯絡！'
      });
    }

    // Priority 6: 智能助手 button (menu first, switch to LLM mode)
    if (text === '智能助手') {
      users[userId] = { ...users[userId], mode: 'llm' };
      return replyWithMenuFirst(replyToken, { type: 'text', text: 'switching to 智能助手' });
    }

    // Priority 7: Already in LLM mode (direct LLM call, no menu)
    if (users[userId]?.mode === 'llm') {
      const llmReply = await callLLM(text);
      return replyMessage(replyToken, { type: 'text', text: llmReply });
    }

    // Priority 8: FAQ keyword match (menu first, route to LLM instead of static reply)
    const msg = text.toLowerCase();
    console.log('🔍 檢查 FAQ 關鍵詞，用戶輸入:', msg);
    
    const isFAQMatch = msg.match(/服務|清潔|外牆|窗戶|service|cleaning|地區|範圍|中部|area|region|費用|價格|多少錢|平方|nt\$|price|cost|fee|時間|多久|幾小時|time|duration|提前|預約|幾週|book|appointment|在場|不在|present|保險|藥水|腐蝕|insurance|付款|現金|轉帳|payment|cash/);
    
    if (isFAQMatch) {
      console.log('✅ FAQ 關鍵詞匹配，轉交 LLM 處理');
      const llmReply = await callLLM(text);
      return replyWithMenuFirst(replyToken, { type: 'text', text: llmReply });
    }

    // Priority 9: No FAQ match (default mode) - switch to LLM
    console.log('❌ 未匹配任何 FAQ 關鍵詞，切換至智能助手');
    users[userId] = { ...users[userId], mode: 'llm' };
    const llmReply = await callLLM(text);
    return replyWithMenuFirst(replyToken, [
      { type: 'text', text: 'switching to 智能助手' },
      { type: 'text', text: llmReply }
    ]);

  } catch (err) {
    console.error('❌ handleEvent 錯誤:', err.message);
    throw err;
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LINE Bot 已啟動，監聽 Port ${PORT}`);
});
