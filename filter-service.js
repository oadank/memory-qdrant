// filter-service.js - 模型过滤服务
// 使用本地 LLM 判断消息是否值得存储，并可提炼核心价值

import fetch from 'node-fetch';

const FILTER_MODEL = 'qwen2.5:14b-instruct';
const OLLAMA_URL = 'http://localhost:11434';

/**
 * 使用模型判断消息是否应该存储，并提炼核心价值
 * @param {string} text - 消息内容
 * @param {string} role - 角色 (user/assistant)
 * @param {boolean} enableRefine - 是否启用提炼（默认 true）
 * @returns {Promise<{should_store: boolean, refined_text: string|null, reason: string, confidence: number}>}
 */
export async function judgeWithLLM(text, role, enableRefine = true) {
    const prompt = `你是一个记忆存储优化器。请完成以下任务：

**任务 1：判断是否值得存储**
存储标准：
- ✅ 应该存储：包含个人信息/偏好/事实；重要决策/问题/解决方案；明确指令/规则/约束；有价值的经验总结
- ❌ 不应存储：问候语/客套话；无意义测试消息；例行问候；纯过程性汇报（无实质结论）

**任务 2：提炼核心价值**（如果值得存储）
- 去除过程性描述、客套话、冗余信息
- 保留核心知识、经验、决策、事实
- 提炼后控制在 100 字以内

**对话内容：**
角色：${role}
内容：${text}

**输出 JSON 格式：**
{
  "should_store": true 或 false,
  "refined_text": "提炼后的内容（如果不值得存储则为 null）",
  "reason": "简短理由（20 字以内）",
  "confidence": 0.0-1.0 之间的置信度
}`;

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
            timeout: 30000 // 30 秒超时
        });

        if (!response.ok) {
            throw new Error(`Ollama 请求失败：${response.status}`);
        }

        const data = await response.json();
        const content = data.message?.content || '';

        try {
            const parsed = JSON.parse(content);
            return {
                should_store: parsed.should_store === true,
                refined_text: parsed.refined_text || null,
                reason: parsed.reason || '无理由',
                confidence: parsed.confidence || 0.5,
                model: FILTER_MODEL
            };
        } catch (e) {
            // JSON 解析失败，尝试从文本中提取
            const shouldStore = content.includes('"should_store": true') ||
                               content.includes('"should_store":true');
            return {
                should_store: shouldStore,
                refined_text: null,
                reason: 'JSON 解析失败，从文本推断',
                confidence: 0.3,
                model: FILTER_MODEL
            };
        }
    } catch (error) {
        console.error(`[filter-service] 模型判断失败：${error.message}`);
        return {
            should_store: null,
            refined_text: null,
            reason: `错误：${error.message}`,
            confidence: 0,
            model: FILTER_MODEL,
            error: true
        };
    }
}

/**
 * 消息队列项
 * @typedef {Object} QueueItem
 * @property {Array} messages - 消息数组
 * @property {number} timestamp - 入队时间
 * @property {number} retryCount - 重试次数
 */

/**
 * 模型过滤队列服务
 */
export class FilterQueue {
    constructor(options = {}) {
        this.queue = [];
        this.processing = false;
        this.batchSize = options.batchSize || 5;      // 每批处理数量
        this.intervalMs = options.intervalMs || 10000; // 处理间隔（毫秒）
        this.maxRetries = options.maxRetries || 2;     // 最大重试次数
        this.stats = {
            enqueued: 0,
            processed: 0,
            stored: 0,
            filtered: 0,
            errors: 0
        };
    }

    /**
     * 将消息加入队列
     * @param {Array} messages - 消息数组
     */
    enqueue(messages) {
        this.queue.push({
            messages,
            timestamp: Date.now(),
            retryCount: 0
        });
        this.stats.enqueued++;
        console.log(`[filter-queue] 消息入队，当前队列长度：${this.queue.length}`);
    }

    /**
     * 开始后台处理
     */
    start() {
        if (this.processing) return;
        this.processing = true;
        this._processLoop();
        console.log('[filter-queue] 队列处理已启动');
    }

    /**
     * 停止处理
     */
    stop() {
        this.processing = false;
        if (this._timer) {
            clearTimeout(this._timer);
        }
        console.log('[filter-queue] 队列处理已停止');
    }

    /**
     * 处理循环
     */
    async _processLoop() {
        while (this.processing) {
            if (this.queue.length > 0) {
                await this._processBatch();
            }
            this._timer = setTimeout(() => this._processLoop(), this.intervalMs);
        }
    }

    /**
     * 处理一批消息
     */
    async _processBatch() {
        const batch = this.queue.splice(0, this.batchSize);
        console.log(`[filter-queue] 开始处理批次，数量：${batch.length}`);

        for (const item of batch) {
            try {
                await this._processItem(item);
            } catch (error) {
                console.error(`[filter-queue] 处理失败：${error.message}`);
                this.stats.errors++;

                // 重试逻辑
                if (item.retryCount < this.maxRetries) {
                    item.retryCount++;
                    this.queue.push(item);
                    console.log(`[filter-queue] 加入重试队列，重试次数：${item.retryCount}`);
                }
            }
        }

        this._logStats();
    }

    /**
     * 处理单个队列项
     */
    async _processItem(item) {
        for (const msg of item.messages) {
            const text = this._extractText(msg.content);
            const role = msg.role;

            if (!text || text.length < 5) {
                this.stats.filtered++;
                continue;
            }

            // 快速规则过滤（先拦掉明显的垃圾）
            if (this._quickFilter(text, role)) {
                this.stats.filtered++;
                console.log(`[filter-queue] 规则过滤：${text.substring(0, 30)}...`);
                continue;
            }

            // 模型判断 + 提炼核心价值
            const result = await judgeWithLLM(text, role, true);

            if (result.should_store === true) {
                // 应该存储 - 触发写入（优先使用提炼后的文本）
                const storeMsg = result.refined_text
                    ? { ...msg, content: result.refined_text, original_text: text }
                    : msg;
                this._onShouldStore(storeMsg, result);
                this.stats.stored++;
            } else if (result.should_store === false) {
                this.stats.filtered++;
            } else {
                // 模型判断失败
                this.stats.errors++;
                // 降级处理：使用规则判断
                if (!this._quickFilter(text, role)) {
                    this._onShouldStore(msg, { reason: '降级处理', confidence: 0.3 });
                    this.stats.stored++;
                } else {
                    this.stats.filtered++;
                }
            }

            this.stats.processed++;
        }
    }

    /**
     * 快速规则过滤（前置过滤）
     */
    _quickFilter(text, role) {
        const textLower = text.toLowerCase();

        // 明显黑名单
        const blacklist = [
            '截屏', '截图', '重启', '打开浏览器', '/new', '/reset',
            'HEARTBEAT', 'heartbeat', 'System', '定时', '提醒'
        ];

        for (const word of blacklist) {
            if (textLower.includes(word.toLowerCase())) {
                return true;
            }
        }

        // 过短消息（但模型可能会挽救一些重要的短消息，所以这里放宽）
        if (text.length < 8) {
            return true;
        }

        return false;
    }

    /**
     * 提取文本内容
     */
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

    /**
     * 当消息应该存储时的回调（由外部设置）
     */
    _onShouldStore(msg, filterResult) {
        // 默认行为：记录日志
        console.log(`[filter-queue] ✅ 存储：${filterResult.reason} (${filterResult.confidence})`);
        // 实际使用时，这里会触发 addMessage
    }

    /**
     * 设置存储回调
     * @param {Function} callback - (msg, filterResult) => void
     */
    setOnShouldStore(callback) {
        this._onShouldStore = callback;
    }

    /**
     * 获取统计信息
     */
    getStats() {
        return { ...this.stats, queueLength: this.queue.length };
    }

    /**
     * 打印统计信息
     */
    _logStats() {
        console.log(`[filter-queue] 统计：已处理=${this.stats.processed}, 存储=${this.stats.stored}, 过滤=${this.stats.filtered}, 错误=${this.stats.errors}, 队列=${this.queue.length}`);
    }
}

// 导出单例
export const defaultQueue = new FilterQueue({
    batchSize: 5,
    intervalMs: 5000,  // 5 秒处理一次，更快响应
    maxRetries: 2
});
