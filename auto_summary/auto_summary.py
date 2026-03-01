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
USER_ID = "user"
SHARED_USER_ID = "shared"
BATCH_SIZE = 100
INTERVAL_HOURS = 6

# 聚类参数
CLUSTER_EPS = 0.3
CLUSTER_MIN_SAMPLES = 3

# 日志配置
logging.basicConfig(
    filename='C:\\Users\\oadan\\openclaw_plugins\\memory-qdrant\\auto_summary\\auto_summary.log',
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

# ---------- 检查 scikit-learn ----------
try:
    from sklearn.cluster import DBSCAN
    import numpy as np
    SKLEARN_AVAILABLE = True
except ImportError:
    SKLEARN_AVAILABLE = False
    logging.error("scikit-learn 未安装，无法进行聚类。请运行: pip install scikit-learn")
    print("错误：需要 scikit-learn 库，请安装后重试。", file=sys.stderr)
    sys.exit(1)

def extract_keywords_from_text(text, max_keywords=15):
    """从文本中提取关键词（使用jieba）"""
    if not text:
        return []
    # 分词
    words = jieba.cut(text)
    # 简单停用词表（可扩充）
    stopwords = set([
        '你','我','他','她','它','他们','她们','我们','你们','的','了','呢','啊','吗','嘛','吧',
        '是','有','和','就','都','还','在','这个','那个','什么','怎么','为啥','为什么','啥','时候','现在'
    ])
    keywords = []
    for w in words:
        w = w.strip()
        if len(w) >= 2 and not re.fullmatch(r'\d+', w) and w not in stopwords:
            keywords.append(w)
    # 简单去重并限制数量
    seen = set()
    unique = []
    for k in keywords:
        if k not in seen:
            seen.add(k)
            unique.append(k)
    return unique[:max_keywords]

def is_meaningful(text):
    """判断文本是否有意义，返回True表示有意义"""
    if not text or len(text) < 3:
        return False
    if re.match(r'^[\s\.,!?;:\'"\-_\d]+$', text):
        return False
    greetings = ['你好', 'hello', 'hi', '在吗', '测试', '继续', '截屏', '截图', '重启', '打开浏览器', '/new', '/reset']
    if text.strip() in greetings:
        return False
    return True

def get_unprocessed_raw():
    """获取未总结的 raw 记忆（带向量），并过滤无意义记忆"""
    # 使用新版 min_should 语法
    filter_cond = {
        "must": [
            {"key": "source_type", "match": {"value": "raw"}}
        ],
        "min_should": {
            "min_count": 1,
            "conditions": [
                {"key": "processed", "match": {"value": False}},
                {"key": "processed", "is_null": True}
            ]
        }
    }
    try:
        response = requests.post(
            f"{QDRANT_URL}/collections/{COLLECTION}/points/scroll",
            json={
                "limit": BATCH_SIZE,
                "filter": filter_cond,
                "with_payload": True,
                "with_vector": True,
            },
            timeout=30
        )
        response.raise_for_status()
        points = response.json().get("result", {}).get("points", [])
        print(f"DEBUG: 原始查询返回 {len(points)} 条记忆")

        # ... 其余过滤逻辑不变
        filtered = []
        for p in points:
            text = p.get("payload", {}).get("text", "")
            if is_meaningful(text):
                filtered.append(p)
            else:
                print(f"过滤无意义: {text[:30]}...")
        return filtered
    except requests.exceptions.ConnectionError as e:
        logging.error(f"❌ Qdrant 连接失败: {e}")
        return []
    except requests.exceptions.Timeout as e:
        logging.error(f"❌ Qdrant 请求超时: {e}")
        return []
    except requests.exceptions.RequestException as e:
        logging.error(f"❌ Qdrant 请求失败: {e}")
        return []
    except Exception as e:
        logging.error(f"❌ 获取未处理记忆失败: {e}")
        return []

def summarize_cluster(texts, point_ids):
    """
    对簇内记忆进行多主题识别和分别总结。
    每个主题输出 1 条独立的 insight 记录。
    """
    prompt = f"""你是一位专业的用户行为分析师。请分析以下用户对话记录，完成以下任务：

**任务 1：主题识别**
分析这些对话记录，识别出几个不同的话题/主题。

**任务 2：分别总结**
对每个主题，总结为 1 条精炼的 insight（1-2 句话，50-150 字）。

**任务 3：分类标注**
为每条 insight 指定类型：
- preference: 用户偏好、喜好
- fact: 客观事实、个人信息
- rule: 用户指定的规则、约束
- skill: 技能、能力
- persona_trait: 人格特质、性格
- experience: 经历、经验
- error: 错误教训、踩坑记录

**对话记录：**
{chr(10).join(texts)}

**输出格式（必须为标准 JSON）：**
{{
  "topics": [
    {{
      "topic_name": "主题简短描述（如'编程偏好'、'音乐喜好'）",
      "insight": "1-2 句话总结，精炼表达",
      "mem_type": "preference|fact|rule|skill|persona_trait|experience|error",
      "confidence": 0.85,
      "importance": 0.75,
      "tags": ["标签 1", "标签 2"]
    }}
  ]
}}

请只输出 JSON，不要任何其他文字：
"""
    try:
        summary_res = requests.post(
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": SUMMARY_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
                "format": "json"
            },
            timeout=120
        )
        summary_res.raise_for_status()
        result = summary_res.json()
        content = result["message"]["content"]

        try:
            data = json.loads(content)
            topics = data.get("topics", [])

            if not topics:
                # 兼容旧格式：如果没有 topics 字段，尝试将整个 content 作为单条 insight
                logging.info(f"LLM 未返回 topics 字段，使用单条总结模式")
                topics = [{
                    "topic_name": "综合总结",
                    "insight": data.get("report", content),
                    "mem_type": data.get("metadata", {}).get("type", "preference"),
                    "confidence": data.get("metadata", {}).get("confidence", 0.8),
                    "importance": data.get("metadata", {}).get("importance", 0.7),
                    "tags": []
                }]

            logging.info(f"识别到 {len(topics)} 个主题")

            # 为每个主题生成一条 insight 记录
            for topic_idx, topic in enumerate(topics):
                insight_text = topic.get("insight", "")
                if not insight_text:
                    continue

                mem_type = topic.get("mem_type", "preference")
                confidence = topic.get("confidence", 0.8)
                importance = topic.get("importance", 0.7)
                tags = topic.get("tags", [])

                # 为 insight 生成向量
                embed_res = requests.post(
                    f"{OLLAMA_URL}/api/embeddings",
                    json={"model": "bge-m3:latest", "prompt": insight_text},
                    timeout=30
                )
                embed_res.raise_for_status()
                vector = embed_res.json()["embedding"]

                # 构建 payload
                insight_payload = {
                    "text": insight_text,
                    "timestamp": int(time.time() * 1000),
                    "userId": SHARED_USER_ID,
                    "conversationId": f"auto_summary_topic_{topic_idx}",
                    "role": "assistant",
                    "type": mem_type,
                    "source_type": "insight",
                    "source": "auto_summary",
                    "confidence": confidence,
                    "importance": importance,
                    "tags": tags,
                    "source_episode_ids": point_ids,
                    "expires_at": int(time.time() * 1000) + 30 * 24 * 3600 * 1000
                }

                # 插入 insight（使用无名向量）
                qdrant_response = requests.put(
                    f"{QDRANT_URL}/collections/{COLLECTION}/points?wait=true",
                    json={
                        "points": [{
                            "id": str(uuid.uuid4()),
                            "vector": vector,
                            "payload": insight_payload
                        }]
                    },
                    timeout=30
                )
                qdrant_response.raise_for_status()

                logging.info(f"✅ 主题 '{topic.get('topic_name', 'unknown')}' 总结完成，类型 {mem_type}")

            # 更新原始记忆的 processed 字段
            for pid in point_ids:
                update_response = requests.post(
                    f"{QDRANT_URL}/collections/{COLLECTION}/points/payload",
                    json={"points": [{"id": pid, "payload": {"processed": True}}]},
                    timeout=30
                )
                update_response.raise_for_status()

            logging.info(f"✅ 簇总结完成，共生成 {len(topics)} 条 insight，处理 {len(point_ids)} 条 raw 记忆")
            return True

        except (json.JSONDecodeError, KeyError) as e:
            logging.error(f"解析 LLM 返回的 JSON 失败：{e}，原始内容：{content}")
            # 降级处理：将整个内容作为单条 insight
            fallback_payload = {
                "text": content,
                "timestamp": int(time.time() * 1000),
                "userId": SHARED_USER_ID,
                "conversationId": "auto_summary_fallback",
                "role": "assistant",
                "type": "inference",
                "source_type": "insight",
                "source": "auto_summary",
                "confidence": 0.5,
                "importance": 0.5,
                "tags": extract_keywords_from_text(content),
                "source_episode_ids": point_ids,
                "expires_at": int(time.time() * 1000) + 30 * 24 * 3600 * 1000
            }
            embed_res = requests.post(
                f"{OLLAMA_URL}/api/embeddings",
                json={"model": "bge-m3:latest", "prompt": content},
                timeout=30
            )
            embed_res.raise_for_status()
            vector = embed_res.json()["embedding"]

            qdrant_response = requests.put(
                f"{QDRANT_URL}/collections/{COLLECTION}/points?wait=true",
                json={
                    "points": [{
                        "id": str(uuid.uuid4()),
                        "vector": vector,
                        "payload": fallback_payload
                    }]
                },
                timeout=30
            )
            qdrant_response.raise_for_status()

            for pid in point_ids:
                update_response = requests.post(
                    f"{QDRANT_URL}/collections/{COLLECTION}/points/payload",
                    json={"points": [{"id": pid, "payload": {"processed": True}}]},
                    timeout=30
                )
                update_response.raise_for_status()

            logging.info(f"✅ 降级处理完成，生成 1 条 fallback insight")
            return True

    except requests.exceptions.ConnectionError as e:
        if "ollama" in str(e).lower():
            logging.error(f"❌ Ollama 连接失败：{e}")
        else:
            logging.error(f"❌ Qdrant 连接失败：{e}")
    except requests.exceptions.Timeout as e:
        logging.error(f"❌ 请求超时：{e}")
    except requests.exceptions.RequestException as e:
        logging.error(f"❌ HTTP 请求失败：{e}")
    except json.JSONDecodeError as e:
        logging.error(f"❌ JSON 解析失败：{e}")
    except KeyError as e:
        logging.error(f"❌ 数据字段缺失：{e}")
    except Exception as e:
        logging.error(f"❌ 簇总结失败：{e}")
    return False

def cluster_and_summarize(raw_points):
    if len(raw_points) < CLUSTER_MIN_SAMPLES:
        logging.info(f"总记忆数 {len(raw_points)} 小于最小簇大小，跳过本轮")
        return

    vectors = []
    valid_points = []
    for p in raw_points:
        vec = p.get("vector")
        if not vec:
            logging.warning(f"点 {p.get('id')} 缺少向量，忽略")
            continue

        # 兼容单向量(list) & 多向量(dict)
        if isinstance(vec, dict):
            vec = vec.get("dense_vector") or vec.get("dense") or vec.get("default")

        if vec:
            vectors.append(vec)
            valid_points.append(p)
        else:
            logging.warning(f"点 {p.get('id')} 缺少 dense_vector，忽略")

    if len(valid_points) < CLUSTER_MIN_SAMPLES:
        logging.info(f"有效向量数 {len(valid_points)} 小于最小簇大小，跳过")
        return

    X = np.array(vectors)
    clustering = DBSCAN(eps=CLUSTER_EPS, min_samples=CLUSTER_MIN_SAMPLES, metric='cosine').fit(X)
    labels = clustering.labels_

    clusters = {}
    for idx, label in enumerate(labels):
        if label != -1:
            clusters.setdefault(label, []).append(valid_points[idx])

    if not clusters:
        logging.info("没有形成任何簇（所有点都是噪声或大小不足）")
        return

    for label, points in clusters.items():
        if len(points) >= CLUSTER_MIN_SAMPLES:
            texts = [p["payload"]["text"] for p in points]
            point_ids = [p["id"] for p in points]
            logging.info(f"处理簇 {label}，包含 {len(points)} 条记忆")
            summarize_cluster(texts, point_ids)
        else:
            logging.info(f"簇 {label} 大小 {len(points)} 小于最小要求，跳过")

def run_once():
    print("正在查询 Qdrant...")
    raw_points = get_unprocessed_raw()
    if raw_points:
        logging.info(f"获取到 {len(raw_points)} 条未处理 raw 记忆")
        cluster_and_summarize(raw_points)
    else:
        logging.info("没有新记忆需要总结")

def main_loop():
    logging.info("自动总结服务启动（启用聚类，使用 30B 模型）")
    while True:
        try:
            run_once()
            time.sleep(INTERVAL_HOURS * 3600)
        except Exception as e:
            logging.error(f"循环异常: {e}")
            time.sleep(300)

def validate_config():
    """验证配置的正确性"""
    try:
        # 验证 Qdrant 连接
        qdrant_response = requests.get(f"{QDRANT_URL}/collections/{COLLECTION}", timeout=10)
        qdrant_response.raise_for_status()

        # 验证 Ollama 连接
        ollama_response = requests.get(f"{OLLAMA_URL}/api/tags", timeout=10)
        ollama_response.raise_for_status()

        # 检查模型是否可用
        models = ollama_response.json().get("models", [])
        model_names = [m.get("name", "") for m in models]
        if not any(SUMMARY_MODEL in m for m in model_names):
            logging.warning(f"警告: 配置的模型 {SUMMARY_MODEL} 未在 Ollama 中找到，将使用默认模型")

        logging.info("✅ 配置验证通过")
        return True
    except Exception as e:
        logging.error(f"❌ 配置验证失败: {e}")
        return False


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Auto summary for memory')
    parser.add_argument('--once', action='store_true', help='Run once and exit')
    parser.add_argument('--validate', action='store_true', help='Validate configuration and exit')
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
        # 运行前先验证配置
        if validate_config():
            run_once()
        else:
            print("配置错误，无法运行")
    else:
        # 运行前先验证配置
        if validate_config():
            main_loop()
        else:
            print("配置错误，无法启动服务")