// filter-service.js - 模型过滤服务
// 使用本地 LLM 实时提炼消息，提取核心价值

import fetch from 'node-fetch';

const FILTER_MODEL = 'qwen2.5:14b-instruct';
const OLLAMA_URL = 'http://localhost:11434';

// 内存保护：最大队列长度
const MAX_QUEUE_LENGTH = 100;

/**
 * 使用模型提炼消息，提取核心价值
 * 存储两段式：
 * 1) 正常：优先存模型梳理后的结论
 * 2) 异常：回退存原文（包含 assistant）
 * @param {string} text - 消息内容
 * @param {string} role - 角色 (user/assistant)
 * @returns {Promise<{action: 'store_raw'|store_refined'|'discard', refined_text: string|null, mem_type: string, keywords: string[]}>}
 */
export async function refineMessage(text, role) {
    const prompt = `你是一个专业的记忆提炼师。请分析这条对话消息，决定如何存储。

**消息类型识别：**
- technical: 技术知识、配置修改、代码修复、API 端点、命令行等
- fact: 事实信息、个人数据、偏好设置
- decision: 决策、结论、方案确定
- instruction: 指令、规则、约束
- experience: 经验总结、踩坑记录、教训
- conversation: 普通对话、问候、过程性描述

**存储策略：**
- 优先输出 store_refined（梳理后的结论）
- 仅在无法梳理时输出 store_raw（保底原文）
- 对“寒暄/催促/情绪表达/无长期价值”的普通对话，输出 discard

**提炼原则：**
- 保留：具体数值、配置、命令、API、关键步骤
- 去除：过程描述、客套话、重复解释
- 输出：精炼的知识点（80-250 字）
- 示例："加油"、"好了吗"、"收到"、"在吗" 这类无长期价值消息应 discard

**对话内容：**
角色：${role}
内容：${text}

**输出 JSON 格式（必须）：**
{
  "type": "technical|fact|decision|instruction|experience|conversation",
  "action": "store_refined|store_raw|discard",
  "refined_text": "提炼后的内容（80-250 字，action 为 store_refined 时必填）",
  "keywords": ["标签 1", "标签 2", "... 至少 8 个，最多 15 个"],
  "confidence": 0.0-1.0
}

示例 - 技术消息：
{
  "type": "technical",
  "action": "store_refined",
  "refined_text": "QQBOT 配置：.env 中 QQBOT_INTENTS=1107300352（全量可收消息）；C2C 发送接口使用/v2/users/{openid}/messages而非/v2/c2c/{openid}/messages",
  "keywords": ["QQBOT", "Intents", "C2C", "API 端点"],
  "confidence": 0.95
}

请只输出 JSON：`;

    try {
        const response = await fetch(`${OLLAMA_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: FILTER_MODEL,
                messages: [{ role: 'user', content: prompt }],
                stream: false,
                format: 'json'
            }),
            timeout: 30000
        });

        if (!response.ok) {
            throw new Error(`Ollama 请求失败：${response.status}`);
        }

        const data = await response.json();
        const content = data.message?.content || '';

        try {
            const parsed = JSON.parse(content);
            return {
                type: parsed.type || 'conversation',
                action: parsed.action || 'store_raw',
                refined_text: parsed.refined_text || null,
                keywords: Array.isArray(parsed.keywords)
                    ? parsed.keywords
                        .map(k => (k ?? '').toString().trim())
                        .filter(k => k.length >= 2 && k.length <= 24)
                        .filter(k => !/^\d+$/.test(k))
                        .slice(0, 15)
                    : [],
                confidence: parsed.confidence || 0.5,
                raw_json: content
            };
        } catch (e) {
            // JSON 解析失败，使用简单规则
            const isTechnical = /[\d\.]+\.[\d\.]+|\.env|\.js|\.py|\/[\w\/]+|http[s]?:\/\/|API|config|endpoint/i.test(text);
            return {
                type: isTechnical ? 'technical' : 'conversation',
                action: 'store_raw',
                refined_text: null,
                keywords: [],
                confidence: 0.3,
                raw_json: content,
                error: true
            };
        }
    } catch (error) {
        console.error(`[filter-service] 模型提炼失败：${error.message}`);
        return {
            type: 'unknown',
            action: 'store_raw',  // 降级：回退存原文（包含 assistant）
            refined_text: null,
            keywords: [],
            confidence: 0,
            raw_json: '',
            error: true
        };
    }
}

/**
 * 消息队列项
 */
export class FilterQueue {
    constructor(options = {}) {
        this.queue = [];
        this.processing = false;
        this.batchSize = options.batchSize || 5;
        this.intervalMs = options.intervalMs || 10000;
        this.maxRetries = options.maxRetries || 1;
        this.maxQueueLength = options.maxQueueLength || MAX_QUEUE_LENGTH;
        this.stats = {
            enqueued: 0,
            processed: 0,
            stored: 0,
            filtered: 0,
            errors: 0
        };
        this._timer = null;
        this._isProcessing = false;
    }

    enqueue(messages) {
        // 内存保护：队列已满时，丢弃最早的消息
        while (this.queue.length >= this.maxQueueLength) {
            const dropped = this.queue.shift();
            this.stats.filtered += (dropped?.messages?.length || 0);
            console.log(`[filter-queue] 队列已满，丢弃旧消息 (${dropped?.messages?.length}条)`);
        }

        this.queue.push({
            messages,
            timestamp: Date.now(),
            retryCount: 0
        });
        this.stats.enqueued += messages.length;
        console.log(`[filter-queue] 消息入队，当前队列长度：${this.queue.length}`);
    }

    start() {
        if (this.processing) return;
        this.processing = true;
        this._processLoop();
        console.log('[filter-queue] 队列处理已启动');
    }

    stop() {
        this.processing = false;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        console.log('[filter-queue] 队列处理已停止');
    }

    clear() {
        this.queue = [];
        console.log('[filter-queue] 队列已清空');
    }

    _processLoop() {
        if (!this.processing) return;

        Promise.resolve().then(async () => {
            if (this.queue.length > 0 && !this._isProcessing) {
                this._isProcessing = true;
                try {
                    await this._processBatch();
                } finally {
                    this._isProcessing = false;
                }
            }
            this._timer = setTimeout(() => this._processLoop(), this.intervalMs);
        }).catch(err => {
            console.error(`[filter-queue] 处理循环错误：${err.message}`);
            this._isProcessing = false;
            this._timer = setTimeout(() => this._processLoop(), this.intervalMs);
        });
    }

    async _processBatch() {
        const batch = this.queue.splice(0, this.batchSize);
        console.log(`[filter-queue] 开始处理批次，数量：${batch.length}`);

        for (const item of batch) {
            try {
                await this._processItem(item);
                await new Promise(resolve => setTimeout(resolve, 300));
            } catch (error) {
                console.error(`[filter-queue] 处理失败：${error.message}`);
                this.stats.errors++;
                if (item.retryCount < this.maxRetries) {
                    item.retryCount++;
                    this.queue.push(item);
                    console.log(`[filter-queue] 加入重试队列，重试次数：${item.retryCount}`);
                }
            }
        }

        if (global.gc) {
            global.gc();
        }
        this._logStats();
    }

    async _processItem(item) {
        for (const msg of item.messages) {
            const text = this._extractText(msg.content);
            const role = msg.role;

            if (!text || text.length < 2) {
                this.stats.filtered++;
                continue;
            }

            // 快速规则过滤（只过滤明显的垃圾）
            if (this._quickFilter(text, role)) {
                this.stats.filtered++;
                continue;
            }

            // 模型提炼
            const result = await refineMessage(text, role);
            const action = (result.action || '').toString().trim().toLowerCase();
            const memType = (result.type || '').toString().trim().toLowerCase();
            const refinedText = (result.refined_text || '').trim();

            // 严格执行模型筛选：discard 直接丢弃，不入库
            if (action === 'discard') {
                this.stats.filtered++;
                this.stats.processed++;
                continue;
            }

            // 会话噪音兜底：普通闲聊若没有提炼结论，直接丢弃
            if (memType === 'conversation' && action !== 'store_refined') {
                this.stats.filtered++;
                this.stats.processed++;
                continue;
            }

            // 两段式：正常优先存梳理结论；异常或无结论时回退存原文
            let storeMsg;

            if (action === 'store_refined' && refinedText) {
                storeMsg = {
                    ...msg,
                    content: refinedText,
                    original_text: text,
                    _mem_type: result.type,
                    _keywords: result.keywords,
                    _should_update: true
                };
            } else {
                storeMsg = {
                    ...msg,
                    content: text,
                    _mem_type: result.type,
                    _keywords: result.keywords,
                    _should_update: true
                };
            }

            this._onShouldStore(storeMsg, result);
            this.stats.stored++;

            this.stats.processed++;
        }
    }

    _quickFilter(text, role) {
        const textLower = text.toLowerCase();
        const blacklist = [
            '截屏', '截图', '重启', '打开浏览器', '/new', '/reset',
            'HEARTBEAT', 'heartbeat', 'System', '定时', '提醒',
            '[agents/tool-images]', 'Image resized to fit limits'
        ];
        for (const word of blacklist) {
            if (textLower.includes(word.toLowerCase())) {
                return true;
            }
        }
        // 降低长度限制，允许更短的消息通过
        if (text.length < 2) {
            return true;
        }
        return false;
    }

    _extractText(content) {
        if (content == null) return '';
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content.map(c => this._extractText(c)).filter(Boolean).join('\n');
        }
        if (typeof content === 'object') {
            if (typeof content.text === 'string') return content.text;
            if (typeof content.content === 'string') return content.content;
        }
        return '';
    }

    setOnShouldStore(callback) {
        this._onShouldStore = callback;
    }

    getStats() {
        return { ...this.stats, queueLength: this.queue.length };
    }

    _logStats() {
        console.log(`[filter-queue] 统计：已处理=${this.stats.processed}, 存储=${this.stats.stored}, 过滤=${this.stats.filtered}, 错误=${this.stats.errors}, 队列=${this.queue.length}`);
    }
}

// 导出单例
export const defaultQueue = new FilterQueue({
    batchSize: 5,
    intervalMs: 10000,
    maxRetries: 1,
    maxQueueLength: 100
});
