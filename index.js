const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_API_ENDPOINT = process.env.NVIDIA_API_ENDPOINT || 'https://integrate.api.nvidia.com/v1/chat/completions';
const LLM_MODEL_NAME = process.env.LLM_MODEL_NAME || 'openai/gpt-oss-20b';

if (!NVIDIA_API_KEY) console.error('❌ Missing NVIDIA_API_KEY');

// Read system prompt from external file to avoid encoding issues
let SYSTEM_PROMPT;
try {
  SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'system-prompt.txt'), 'utf8');
} catch (err) {
  console.error('❌ Failed to load system-prompt.txt:', err.message);
  SYSTEM_PROMPT = 'You are a helpful assistant.'; // Fallback
}

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
            content: SYSTEM_PROMPT
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
