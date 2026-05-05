const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_MODEL = 'z-ai/glm4.7'; // GLM-4.7 model

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
      { type: 'message', label: '📞 聯絡資訊', text: '聯絡資訊' }
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

async function callNvidiaLLM(userMessage) {
  try {
    console.log('🤖 呼叫 NVIDIA LLM (z-ai/glm4.7)...');
    if (!NVIDIA_API_KEY) {
      console.error('❌ NVIDIA_API_KEY 未设置');
      return null;
    }
    console.log('🔑 API Key 长度:', NVIDIA_API_KEY.length);
    
    const response = await axios.post(
      'https://integrate.api.nvidia.com/v1/chat/completions',
      {
        model: NVIDIA_MODEL,
        messages: [
          { role: 'system', content: '你是煥然逸新房屋外觀清潔公司的客服助手。請簡潔專業地回答客戶關於外牆清潔、窗戶清潔、報價、預約等問題。回答限制在200字內。' },
          { role: 'user', content: userMessage }
        ],
        max_tokens: 300,
        temperature: 0.7,
        stream: false
      },
      {
        headers: {
          'Authorization': `Bearer ${NVIDIA_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
    console.log('✅ LLM 回應成功，状态码:', response.status);
    console.log('📦 返回数据结构:', JSON.stringify(response.data).substring(0, 200));
    
    const choice = response.data?.choices?.[0];
    const content = choice?.message?.content;
    
    if (!content) {
      console.error('❌ LLM 返回内容为空. choice:', JSON.stringify(choice).substring(0, 100));
      return null;
    }
    
    return content.trim();
  } catch (err) {
    console.error('❌ NVIDIA LLM 錯誤:');
    console.error('  状态码:', err.response?.status);
    console.error('  错误讯息:', err.response?.data || err.message);
    return null;
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

    // 1. 我的ID
    if (text === '我的ID') {
      return replyMessage(replyToken, { type: 'text', text: `你的User ID: ${userId}` });
    }

    // 2. 主選單
    if (text === '主選單' || text === 'menu') {
      users[userId] = { ...users[userId], step: 'menu' };
      return replyMessage(replyToken, MAIN_MENU);
    }

    // 3. 常見問題
    if (text === '常見問題' || text === 'FAQ') {
      let replyText = '📋 常見問題 (FAQ)\n\n';
      FAQ.forEach((item) => { replyText += `${item.q}\n${item.a}\n\n`; });
      replyText += '輸入「預約清潔」開始預約，或「主選單」返回。';
      return replyMessage(replyToken, { type: 'text', text: replyText });
    }

    // 4. 聯絡資訊
    if (text === '聯絡資訊') {
      return replyMessage(replyToken, {
        type: 'text',
        text: '📞 煥然逸新 房屋外觀清潔公司\n服務地區：中部地區\n服務項目：外牆及窗戶清潔\n聯絡方式：請透過「預約清潔」與我們聯絡！'
      });
    }

    // 5. 預約清潔
    if (text === '預約清潔' || (users[userId] && users[userId].step === 'booking')) {
      if (!users[userId] || users[userId].step !== 'booking') {
        users[userId] = { step: 'booking', data: {} };
        return replyMessage(replyToken, { type: 'text', text: '📅 開始預約清潔\n請輸入您的姓名：' });
      }
    }

    // 6. 處理預約流程
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

    // 7. FAQ 關鍵詞匹配
    const msg = text.toLowerCase();
    if (msg.match(/服務|清潔|外牆|窗戶/)) return replyMessage(replyToken, { type: 'text', text: FAQ[0].a });
    if (msg.match(/地區|範圍|中部/)) return replyMessage(replyToken, { type: 'text', text: FAQ[1].a });
    if (msg.match(/費用|價格|多少錢|平方|nt\$/)) return replyMessage(replyToken, { type: 'text', text: FAQ[2].a });
    if (msg.match(/時間|多久|幾小時/)) return replyMessage(replyToken, { type: 'text', text: FAQ[3].a });
    if (msg.match(/提前|預約|幾週/)) return replyMessage(replyToken, { type: 'text', text: FAQ[4].a });
    if (msg.match(/在場|不在/)) return replyMessage(replyToken, { type: 'text', text: FAQ[5].a });
    if (msg.match(/保險|藥水|腐蝕/)) return replyMessage(replyToken, { type: 'text', text: FAQ[6].a });
    if (msg.match(/付款|現金|轉帳/)) return replyMessage(replyToken, { type: 'text', text: FAQ[7].a });

    // 8. 無法匹配 - 使用 NVIDIA LLM
    console.log('🔍 未匹配FAQ，嘗試呼叫 NVIDIA LLM...');
    if (!NVIDIA_API_KEY) {
      console.error('❌ NVIDIA_API_KEY 未設置');
    }
    const llmReply = await callNvidiaLLM(text);
    if (llmReply) {
      console.log('✅ LLM 回覆成功');
      return replyMessage(replyToken, { type: 'text', text: llmReply });
    }
    
    console.error('❌ LLM 回覆失敗，顯示預設訊息');
    // LLM 失敗才顯示預設訊息
    return replyMessage(replyToken, {
      type: 'text',
      text: '抱歉，我暫時無法處理您的問題。請使用「主選單」選擇服務，或輸入「常見問題」查看相關資訊。'
    });
  } catch (err) {
    console.error('❌ handleEvent 錯誤:', err.message);
    throw err;
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LINE Bot 已啟動，監聽 Port ${PORT}`);
});
