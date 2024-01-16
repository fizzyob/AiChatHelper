// 导入所需的模块
const express = require('express');
const { exec } = require('child_process');
const axios = require('axios');

// 创建 Express 应用
const app = express();
const port = 3000; // 使用Replit提供的端口

// 从环境变量获取最大重试次数，默认为 1
const maxRetries = process.env.MAX_RETRIES ? parseInt(process.env.MAX_RETRIES) : 1;

// 计数器和 API Key
let retryCount = 0;
let apikey = '';

// 错误处理函数
function handleRetryableError(res, error, errorMessage, retryFunction) {
    if (retryCount < maxRetries) {
        // 等待2秒后重试
        setTimeout(() => {
            retryCount++;
            retryFunction();
        }, 2000);
    } else {
        respondWithError(res, errorMessage);
    }
}

// 发送错误响应
function respondWithError(res, messages) {
    res.json({
        'choices': [{
            'message': {
                'role': 'assistant',
                'content': messages
            }
        }]
    });
}

// 使用 JSON 解析中间件
app.use(express.json());

// 处理请求的主要逻辑
app.use('/', async (req, res) => {
    try {
        // 使用环境变量进行验证
        const wxidArray = process.env.WXID_ARRAY ? process.env.WXID_ARRAY.split(',') : [];
        const wxid = req.headers['wxid'];

        // 判断 wxidArray 是否为空，如果为空则不进行授权验证，直接执行后续程序
        if (wxidArray.length > 0 && !wxidArray.includes(wxid)) {
            respondWithError(res, '我是狗，偷接口，偷了接口当小丑～');
            return;
        }

        const messages = req.body.messages;
        if (!messages) {
            respondWithError(res, '出错啦，请添加到插件的反代中使用！');
            return;
        }

        // 初始化失败重试计数器
        retryCount = 0;

        const chat_model = req.body.model.trim().toLowerCase();
        if (chat_model == 'gpt-3.5-turbo' || chat_model == 'gpt-4') {
            // 对接 ChatGPT 的 API
            await handleChatGPTAPIRequest(req, res, chat_model);
        } else if (chat_model == 'gemini-pro' || chat_model == 'gemini') {
            const authorization = req.headers['authorization'];
            apikey = authorization.slice(7);

            // 格式化 Gemini 的消息
            const formattedMessages = formatMessagesForGemini(messages);
            // 对接 Gemini 的 API
            await processGeminiRequest(formattedMessages, res);
        } else {
            respondWithError(res, '不支持的 chat_model 类型');
        }
    } catch (error) {
        respondWithError(res, error.toString());
    }
});

// 处理 ChatGPT 请求
async function handleChatGPTAPIRequest(req, res, chat_model) {
    const API_KEY = req.headers['authorization'];
    const url = 'https://api.openai.com/v1/chat/completions';

    try {
        const response = await axios({
            method: req.method,
            url: url,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': API_KEY,
            },
            data: {
                'model': chat_model,
                'messages': req.body.messages,
                'temperature': process.env.CHATGPT_TEMPERATURE ? parseFloat(process.env.CHATGPT_TEMPERATURE) : 1
            }
        });

        res.json(response.data);
    } catch (error) {
        handleRetryableError(res, error, `ChatGPT请求出错: ${error.toString()}`, () => handleChatGPTAPIRequest(req, res, chat_model));
    }
}

// 格式化符合 Gemini 的 messages
function formatMessagesForGemini(messages) {
    let formattedMessages = [];

    messages.forEach((item, index) => {
        // 插件传递过来的第一条消息是预设，Gemini第一条消息要求是用户，所以当设置预设后添加上一条模型回复的内容
        if (index === 0) {
            formattedMessages.push({
                'role': 'user',
                'parts': [{
                    'text': item.content
                }]
            }, {
                'role': 'model',
                'parts': [{
                    'text': '好的'
                }]
            });
        } else if (index === 1 && item.role === 'assistant') {
            // 由于Gemini接收对话的格式必须是user/model/user/model...，多条对话时插件传递过来的第二条可能会变成assistant所以忽略掉
        } else {
            if (item.role === 'assistant') {
                formattedMessages.push({
                    'role': 'model',
                    'parts': [{
                        'text': item.content
                    }]
                });
            } else {
                formattedMessages.push({
                    'role': 'user',
                    'parts': [{
                        'text': item.content
                    }]
                });
            }
        }
    });

    return formattedMessages;
}

// 处理 Gemini 请求
async function processGeminiRequest(contents, res) {
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apikey}`;

        const response = await axios.post(url, {
            'contents': contents,
            "safetySettings": [{
                "category": "HARM_CATEGORY_HARASSMENT",
                "threshold": "BLOCK_NONE"
            }, {
                "category": "HARM_CATEGORY_HATE_SPEECH",
                "threshold": "BLOCK_NONE"
            }, {
                "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                "threshold": "BLOCK_NONE"
            }, {
                "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
                "threshold": "BLOCK_NONE"
            }]
        });

        if (response.data.candidates) {
            res.json({
                'choices': [{
                    'message': {
                        'role': 'assistant',
                        'content': response.data.candidates[0].content.parts[0].text
                    }
                }]
            });
        } else {
            handleRetryableError(res, new Error('Gemini请求出错'), 'Gemini请求出错', () => processGeminiRequest(contents, res));
        }
    } catch (error) {
        handleRetryableError(res, error, `Gemini请求出错: ${error.toString()}`, () => processGeminiRequest(contents, res));
    }
}

// 保持活动路由处理程序
app.get('/keep-alive', (req, res) => {
  // 执行命令以保持会话活动
  exec('echo "保持活动"', (error, stdout, stderr) => {
    if (error) {
      console.error(`保持活动错误: ${error.message}`);
      res.status(500).send('内部服务器错误');
      return;
    }
    console.log(`保持活动响应: ${stdout}`);
    res.send('保持活动成功');
  });
});

// 设置定时器，每隔5分钟执行一次保持活动操作
setInterval(() => {
  // 直接调用保持活动处理程序
  axios.get('http://localhost:3000/keep-alive')
    .then(response => {
      console.log('保持活动内部请求:', response.data);
    })
    .catch(error => {
      console.error('保持活动内部请求错误:', error.message);
    });
}, 5 * 60 * 1000);

// 启动 Express 应用
app.listen(port, () => {
    console.log(`服务启动成功 http://localhost:${port}`);
});
