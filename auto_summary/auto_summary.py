# auto_summary.py - 记忆实时提炼服务
# 使用 30B 模型对原始消息进行深度提炼，提取核心价值

import requests
import time
import logging
import json
import uuid
import sys
import jieba
import re
from datetime import datetime
import argparse

# ========== 配置 ==========
QDRANT_URL = "http://localhost:6333"
COLLECTION = "agent_memory"
OLLAMA_URL = "http://localhost:11434"
SUMMARY_MODEL = "huihui_ai/qwen3-abliterated:30b-a3b-instruct-2507-q3_K_M"
EMBEDDING_MODEL = "bge-m3:latest"
SHARED_USER_ID = "shared"
BATCH_SIZE = 20  # 每次处理 20 条，按批次总结
INTERVAL_SECONDS = 7200  # 每 2 小时检查一次

# 日志配置
logging.basicConfig(
    filename='C:\\Users\\oadan\\openclaw_plugins\\memory-qdrant\\auto_summary\\auto_summary.log',
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)


def qdrant_scroll_with_fallback(payload, timeout=30):
    """兼容不同 Qdrant 版本的 scroll 请求。"""
    url = f"{QDRANT_URL}/collections/{COLLECTION}/points/scroll"
    response = requests.post(url, json=payload, timeout=timeout)

    # 旧版本 Qdrant 可能不支持 order_by，遇到 400 自动降级重试
    if response.status_code == 400 and "order_by" in payload:
        fallback_payload = dict(payload)
        fallback_payload.pop("order_by", None)
        response = requests.post(url, json=fallback_payload, timeout=timeout)

    response.raise_for_status()
    return response

def extract_keywords_from_text(text, max_keywords=15):
    """从文本中提取关键词（使用 jieba）"""
    if not text:
        return []
    words = jieba.cut(text)
    stopwords = set([
        '你','我','他','她','它','他们','她们','我们','你们','的','了','呢','啊','吗','嘛','吧',
        '是','有','和','就','都','还','在','这个','那个','什么','怎么','为啥','为什么','啥','时候','现在'
        ,'conversation','info','untrusted','metadata','message','message_id','conversation_id','user_id','channel_id','sender'
    ])
    keywords = []
    for w in words:
        w = w.strip()
        if (
            len(w) >= 2
            and not re.fullmatch(r'\d+', w)
            and not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', w, flags=re.IGNORECASE)
            and not re.fullmatch(r'[0-9a-f]{16,}', w, flags=re.IGNORECASE)
            and w.lower() not in stopwords
        ):
            keywords.append(w)
    seen = set()
    unique = []
    for k in keywords:
        if k not in seen:
            seen.add(k)
            unique.append(k)
    return unique[:max_keywords]

def strip_sender_metadata(text):
    s = (text or "").strip()
    s = re.sub(r'^\s*(user|assistant)\s*:\s*', '', s, flags=re.IGNORECASE)
    s = re.sub(r'\[agents/tool-images\][^\n\r]*', ' ', s, flags=re.IGNORECASE)
    s = re.sub(
        r'(?:sender|conversation\s*info)\s*\(untrusted metadata\)\s*:\s*```(?:json)?[\s\S]*?```',
        ' ',
        s,
        flags=re.IGNORECASE
    )
    s = re.sub(r'(?:sender|conversation\s*info)\s*\(untrusted metadata\)\s*:\s*', ' ', s, flags=re.IGNORECASE)
    s = re.sub(r'^\s*(?:\[\[[a-z0-9_:-]+\]\]\s*)+', '', s, flags=re.IGNORECASE)
    s = re.sub(r'\s*\[\[[a-z0-9_:-]+\]\]\s*', ' ', s, flags=re.IGNORECASE)
    s = re.sub(r'(?:^|\s)\[[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}[^\]]{0,40}\]\s*', ' ', s)
    s = re.sub(r'^\s*\[[^\]]{8,100}\]\s*', '', s)
    s = re.sub(r'\s+', ' ', s)
    return s.strip()

def normalize_mem_type(raw_type):
    """把模型返回的类型统一到固定枚举。"""
    value = (raw_type or "").strip().lower()
    mapping = {
        "technical": "technical",
        "tech": "technical",
        "技术": "technical",
        "fact": "fact",
        "事实": "fact",
        "decision": "decision",
        "决策": "decision",
        "结论": "decision",
        "instruction": "instruction",
        "rule": "instruction",
        "规则": "instruction",
        "指令": "instruction",
        "experience": "experience",
        "经验": "experience",
        "教训": "experience",
    }
    return mapping.get(value, "fact")

def build_insight_keywords(llm_keywords, essence, mem_type, role, min_count=8, max_count=15):
    """为精华构建更丰富标签：模型词 + 文本分词 + 类型词。"""
    merged = []

    for kw in (llm_keywords or []):
        s = str(kw).strip()
        if (
            len(s) >= 2
            and len(s) <= 24
            and not re.fullmatch(r"\d+", s)
            and not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", s, flags=re.IGNORECASE)
            and not re.fullmatch(r"[0-9a-f]{16,}", s, flags=re.IGNORECASE)
            and s.lower() not in {"conversation", "info", "untrusted", "metadata", "message_id", "conversation_id", "user_id", "channel_id", "sender"}
        ):
            merged.append(s)

    merged.extend(extract_keywords_from_text(essence, max_keywords=max_count * 2))

    type_hints = {
        "technical": ["技术", "配置", "命令", "API"],
        "fact": ["事实", "信息", "记录"],
        "decision": ["决策", "结论", "方案"],
        "instruction": ["规则", "约束", "指令"],
        "experience": ["经验", "踩坑", "教训"],
    }
    merged.extend(type_hints.get(mem_type, []))
    if role:
        merged.append(str(role).strip().lower())

    seen = set()
    out = []
    for k in merged:
        kk = str(k).strip()
        if not kk:
            continue
        lk = kk.lower()
        if lk in seen:
            continue
        seen.add(lk)
        out.append(kk)
        if len(out) >= max_count:
            break

    if len(out) < min_count:
        fallback = extract_keywords_from_text(essence, max_keywords=max_count)
        for k in fallback:
            lk = k.lower()
            if lk not in seen:
                seen.add(lk)
                out.append(k)
            if len(out) >= min_count:
                break

    return out[:max_count]

def build_labeled_essence(essence, mem_type):
    """在总结正文前添加类型标签，便于肉眼直接识别。"""
    text = (essence or "").strip()
    if not text:
        return text
    prefix_map = {
        "technical": "技术",
        "fact": "事实",
        "decision": "决策",
        "instruction": "规则",
        "experience": "经验",
    }
    label = prefix_map.get(mem_type, "事实")
    if re.match(rf"^\s*{label}\s*[:：]", text):
        return text
    return f"{label}：{text}"

def refine_with_llm(text, role):
    """使用 30B 模型深度提炼消息"""
    prompt = f"""你是一位专业的知识提炼师。请分析这条对话消息，提炼出可长期保存的核心知识点。

**消息内容：**
角色：{role}
内容：{text}

**任务：**
1. 识别消息类型：
   - technical: 技术知识、配置、代码、API、命令
   - fact: 事实信息、个人数据、偏好
   - decision: 决策、结论
   - instruction: 规则、约束、指令
   - experience: 经验、教训、踩坑记录

2. 提炼核心价值：
   - 保留：具体数值、配置、命令、API、关键步骤、核心结论
   - 去除：过程描述、客套话、重复解释、临时状态
   - 输出：精炼的知识点（80-250 字）

3. 提取关键词：至少 8 个标签，最多 15 个

**输出 JSON 格式：**
{{
  "type": "technical|fact|decision|instruction|experience",
  "essence": "提炼后的核心知识点（80-250 字）",
  "keywords": ["关键词 1", "关键词 2", "... 至少 8 个"]
}}

示例 - 技术消息：
{{
  "type": "technical",
  "essence": "QQBOT 配置：.env 中 QQBOT_INTENTS=1107300352（全量可收消息）；C2C 发送接口使用/v2/users/{{openid}}/messages 而非/v2/c2c/{{openid}}/messages",
  "keywords": ["QQBOT", "Intents", "C2C", "API 端点"]
}}

请只输出 JSON："""

    try:
        response = requests.post(
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": SUMMARY_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
                "format": "json"
            },
            timeout=60
        )
        response.raise_for_status()
        result = response.json()
        content = result["message"]["content"]

        try:
            data = json.loads(content)
            return {
                "success": True,
                "type": data.get("type", "fact"),
                "essence": data.get("essence", ""),
                "keywords": data.get("keywords", []),
                "raw_json": content
            }
        except json.JSONDecodeError as e:
            logging.error(f"JSON 解析失败：{e}, 内容：{content}")
            return {"success": False, "error": "JSON 解析失败"}

    except requests.exceptions.Timeout:
        logging.error("LLM 请求超时")
        return {"success": False, "error": "超时"}
    except Exception as e:
        logging.error(f"LLM 调用失败：{e}")
        return {"success": False, "error": str(e)}

def generate_embedding(text):
    """生成向量嵌入"""
    try:
        response = requests.post(
            f"{OLLAMA_URL}/api/embeddings",
            json={"model": EMBEDDING_MODEL, "prompt": text},
            timeout=30
        )
        response.raise_for_status()
        return response.json()["embedding"]
    except Exception as e:
        logging.error(f"生成向量失败：{e}")
        return None

def search_similar_by_content(content, limit=5):
    """通过内容搜索相似记忆"""
    try:
        # 使用关键词搜索作为近似匹配
        keywords = extract_keywords_from_text(content, max_keywords=3)

        if not keywords:
            return []

        # 构建过滤条件
        should_conditions = []
        for keyword in keywords:
            should_conditions.append({"key": "tags", "match": {"value": keyword}})

        filter_cond = {
            "should": should_conditions
        }

        response = requests.post(
            f"{QDRANT_URL}/collections/{COLLECTION}/points/scroll",
            json={"limit": limit, "filter": filter_cond, "with_payload": True, "with_vector": False},
            timeout=30
        )
        response.raise_for_status()
        return response.json().get("result", {}).get("points", [])
    except Exception as e:
        logging.error(f"按内容搜索失败：{e}")
        return []

def calculate_similarity(text1, text2):
    """计算文本相似度"""
    # 清理文本
    clean1 = re.sub(r'[^\w\u4e00-\u9fff]', '', text1.lower())
    clean2 = re.sub(r'[^\w\u4e00-\u9fff]', '', text2.lower())

    if not clean1 or not clean2:
        return 0.0

    if clean1 == clean2:
        return 1.0

    # 计算最长公共子序列比例
    len1, len2 = len(clean1), len(clean2)

    # 动态规划计算最长公共子序列
    dp = [[0] * (len2 + 1) for _ in range(len1 + 1)]

    for i in range(1, len1 + 1):
        for j in range(1, len2 + 1):
            if clean1[i - 1] == clean2[j - 1]:
                dp[i][j] = dp[i - 1][j - 1] + 1
            else:
                dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])

    lcs_length = dp[len1][len2]
    similarity = (2 * lcs_length) / (len1 + len2)  # 使用LCS比例作为相似度
    return similarity

def normalize_role(role):
    value = (role or "").strip().lower()
    return value if value in ["user", "assistant"] else "user"

def update_memory(point_id, refined_text, mem_type, keywords, role=None, timestamp=None):
    """更新记忆"""
    try:
        fixed_timestamp = timestamp if isinstance(timestamp, (int, float)) and timestamp > 0 else int(time.time() * 1000)
        fixed_role = normalize_role(role)
        response = requests.put(
            f"{QDRANT_URL}/collections/{COLLECTION}/points/payload",
            json={
                "payload": {
                    "text": refined_text,
                    "mem_type": mem_type,
                    "tags": keywords,
                    "role": fixed_role,
                    "timestamp": fixed_timestamp,
                    "source_type": "refined",
                    "processed": True
                },
                "points": [point_id]
            },
            timeout=30
        )
        response.raise_for_status()
        logging.info(f"已更新记忆 {point_id}")
        return True
    except Exception as e:
        logging.error(f"更新记忆失败：{e}")
        return False

def create_insight_if_not_duplicate(refined_text, mem_type, keywords, source_ids):
    """创建新的 insight 记忆，避免重复"""
    try:
        # 检查是否已存在相似的记忆，避免重复创建
        similar_existing = search_similar_by_content(refined_text, limit=5)  # 增加返回数量以进行更详细的检查

        if similar_existing:
            # 检查多个相似项，找出最佳匹配
            for existing_item in similar_existing:
                existing_text = existing_item.get("payload", {}).get("text", "")
                existing_mem_type = existing_item.get("payload", {}).get("mem_type", "")

                # 检查文本相似度
                similarity_score = calculate_similarity(refined_text, existing_text)

                # 如果内容相似且类型一致，则认为是重复的
                if similarity_score > 0.85 and existing_mem_type == mem_type:
                    logging.info(f"检测到相似记忆，跳过创建：相似度 {similarity_score:.2f}")
                    return False

                # 也检查是否是内容完全相同但标签不同的情况
                if existing_text == refined_text:
                    logging.info(f"检测到完全相同的记忆，跳过创建")
                    return False

        vector = generate_embedding(refined_text)
        if not vector:
            return False

        payload = {
            "text": refined_text,
            "timestamp": int(time.time() * 1000),
            "userId": SHARED_USER_ID,
            "conversationId": "auto_refine",
            "role": "assistant",
            "type": mem_type,
            "mem_type": mem_type,
            "source_type": "insight",
            "source": "auto_refine",
            "confidence": 0.9,
            "importance": 0.8,
            "tags": keywords,
            "source_episode_ids": source_ids,
            "processed": True
        }

        response = requests.put(
            f"{QDRANT_URL}/collections/{COLLECTION}/points?wait=true",
            json={"points": [{"id": str(uuid.uuid4()), "vector": vector, "payload": payload}]},
            timeout=30
        )
        response.raise_for_status()
        logging.info(f"已创建 insight: {refined_text[:50]}...")
        return True
    except Exception as e:
        logging.error(f"创建 insight 失败：{e}")
        return False

def get_unprocessed_candidates():
    """获取未处理的候选记忆（优先 refined，兼容 raw 回退）。"""
    try:
        filter_cond = {
            "should": [
                {"key": "source_type", "match": {"value": "refined"}},
                {"key": "source_type", "match": {"value": "raw"}}
            ],
            # 兼容旧数据：processed 字段缺失也视为“未处理”
            "must_not": [
                {"key": "processed", "match": {"value": True}},
                {"key": "processed", "match": {"value": "processing"}}
            ]
        }

        response = qdrant_scroll_with_fallback(
            {
                "limit": BATCH_SIZE,
                "filter": filter_cond,
                "with_payload": True,
                "with_vector": False,
                "order_by": {"key": "timestamp", "direction": "asc"}  # 按时间戳升序排列，优先处理老的记忆
            },
            timeout=30
        )
        points = response.json().get("result", {}).get("points", [])

        # 过滤无意义消息
        filtered = []
        for p in points:
            text = p.get("payload", {}).get("text", "")
            if len(text) >= 10 and text not in ['你好', '测试', '继续', 'hello', 'hi', 'Hi']:
                # 标记为正在处理，防止其他实例重复处理
                point_id = p.get("id")

                # 尝试原子性地更新状态为"processing"，使用点ID直接更新
                try:
                    update_response = requests.put(
                        f"{QDRANT_URL}/collections/{COLLECTION}/points/payload",
                        json={
                            "payload": {"processed": "processing"},
                            "points": [point_id]
                        },
                        timeout=10
                    )

                    # 兼容不同实现：2xx 都视为成功
                    if 200 <= update_response.status_code < 300:
                        filtered.append(p)
                    else:
                        # 如果更新失败，可能是因为其他进程已经处理了，跳过这个点
                        logging.info(
                            f"记忆 {point_id} 标记处理中失败，状态码={update_response.status_code}，跳过"
                        )
                except Exception as e:
                    logging.warning(f"标记记忆 {point_id} 为处理中时出错: {e}")

        return filtered
    except Exception as e:
        logging.error(f"获取未处理记忆失败：{e}")
        return []

def mark_processed(point_id):
    """仅标记为已处理，不改原文。"""
    try:
        response = requests.put(
            f"{QDRANT_URL}/collections/{COLLECTION}/points/payload",
            json={
                "payload": {"processed": True},
                "points": [point_id]
            },
            timeout=15
        )
        response.raise_for_status()
        return True
    except Exception as e:
        logging.error(f"标记 processed 失败（{point_id}）：{e}")
        return False

def summarize_batch_with_llm(items):
    """按批次总结，返回一条综合 insight。"""
    lines = []
    for i, it in enumerate(items, 1):
        role = normalize_role(it.get("payload", {}).get("role"))
        text = strip_sender_metadata(it.get("payload", {}).get("text", ""))
        if not text:
            continue
        lines.append(f"{i}. ({role}) {text}")
    merged = "\n".join(lines)
    if not merged.strip():
        return {"success": False, "error": "empty batch"}

    # 控制模型输入体积，避免超长
    if len(merged) > 8000:
        merged = merged[:8000] + "\n...（已截断）"

    prompt = f"""你是知识归纳助手。以下是同一批次的已梳理对话记录，请做一次“批次总结”（不是逐条复述）。

要求：
1) 合并同类信息，提炼核心稳定结论；
2) 去掉重复、口语化内容；
3) 输出一条可长期记忆的总结（120-320字）；
4) 提供 8-15 个关键词。

记录列表：
{merged}

请仅输出 JSON：
{{
  "type": "technical|fact|decision|instruction|experience",
  "essence": "批次总结内容",
  "keywords": ["关键词1","关键词2"]
}}"""

    try:
        response = requests.post(
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": SUMMARY_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
                "format": "json"
            },
            timeout=90
        )
        response.raise_for_status()
        content = response.json().get("message", {}).get("content", "")
        data = json.loads(content)
        return {
            "success": True,
            "type": data.get("type", "fact"),
            "essence": data.get("essence", "").strip(),
            "keywords": data.get("keywords", [])
        }
    except Exception as e:
        logging.error(f"批次总结失败：{e}")
        return {"success": False, "error": str(e)}

def run_once():
    """运行一次处理"""
    logging.info("开始检查未处理记忆（批次总结模式）...")
    points = get_unprocessed_candidates()

    if not points:
        logging.info("没有需要处理的记忆")
        return

    logging.info(f"找到 {len(points)} 条未处理记忆，开始批次总结")

    result = summarize_batch_with_llm(points)
    point_ids = [p.get("id") for p in points if p.get("id")]

    if result.get("success") and result.get("essence"):
        mem_type = normalize_mem_type(result.get("type"))
        essence = result.get("essence", "")
        labeled_essence = build_labeled_essence(essence, mem_type)
        keywords = build_insight_keywords(result.get("keywords"), essence, mem_type, role="assistant")
        create_insight_if_not_duplicate(labeled_essence, mem_type, keywords, point_ids)
    else:
        logging.warning("本批次总结失败：跳过创建 insight，仅标记避免重复。")

    for pid in point_ids:
        mark_processed(pid)

    logging.info("批次处理完成")

def main_loop():
    """主循环"""
    logging.info(f"自动提炼服务启动（模型：{SUMMARY_MODEL}）")
    while True:
        try:
            run_once()
            time.sleep(INTERVAL_SECONDS)
        except Exception as e:
            logging.error(f"循环异常：{e}")
            time.sleep(30)

def validate_config():
    """验证配置"""
    try:
        # 检查 Qdrant
        response = requests.get(f"{QDRANT_URL}/collections/{COLLECTION}", timeout=10)
        response.raise_for_status()

        # 检查 Ollama
        response = requests.get(f"{OLLAMA_URL}/api/tags", timeout=10)
        response.raise_for_status()

        logging.info("配置验证通过")
        return True
    except Exception as e:
        logging.error(f"配置验证失败：{e}")
        return False

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='记忆自动提炼服务')
    parser.add_argument('--once', action='store_true', help='运行一次后退出')
    parser.add_argument('--validate', action='store_true', help='验证配置后退出')
    args = parser.parse_args()

    if args.validate:
        print("正在验证配置...")
        if validate_config():
            print("配置验证成功")
            sys.exit(0)
        else:
            print("配置验证失败")
            sys.exit(1)

    if args.once:
        if validate_config():
            run_once()
        else:
            print("配置错误，无法运行")
    else:
        if validate_config():
            main_loop()
        else:
            print("配置错误，无法启动服务")
