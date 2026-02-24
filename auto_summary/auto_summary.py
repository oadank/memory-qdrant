import requests
import time
import logging
import json
from datetime import datetime

# ========== 配置（与插件保持一致）==========
QDRANT_URL = "http://localhost:6333"
COLLECTION = "agent_memory"
OLLAMA_URL = "http://localhost:11434"
SUMMARY_MODEL = "qwen2.5:14b-instruct"
USER_ID = "claw"  # 如果要处理多个用户，可以遍历
BATCH_SIZE = 100  # 每次处理的最大条数
INTERVAL_HOURS = 6  # 每6小时运行一次（脚本内自己循环）

# 日志配置
logging.basicConfig(
    filename='auto_summary.log',
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

def get_unprocessed_raw():
    """获取未总结的 raw 记忆（按时间排序，防止乱序）"""
    filter_cond = {
        "must": [
            {"key": "userId", "match": {"value": USER_ID}},
            {"key": "type", "match": {"value": "raw"}},
            {"key": "processed", "match": {"value": False}}
        ]
    }
    # 按时间升序，先处理老的
    response = requests.post(
        f"{QDRANT_URL}/collections/{COLLECTION}/points/scroll",
        json={
            "limit": BATCH_SIZE,
            "filter": filter_cond,
            "with_payload": True,
            "with_vector": False
        }
    )
    points = response.json().get("result", {}).get("points", [])
    return points

def summarize_raw_batch(raw_points):
    """对一批 raw 记忆进行总结（按主题聚类后分别总结）"""
    if len(raw_points) < 2:  # 少于2条不总结（单条可能信息不全）
        logging.info(f"跳过总结：批次只有 {len(raw_points)} 条")
        return
    
    # 提取文本和 ID
    texts = [p["payload"]["text"] for p in raw_points]
    point_ids = [p["id"] for p in raw_points]
    
    # 构建 prompt
    prompt = f"""请根据以下用户的多条对话记录，总结出用户的长期偏好、习惯或重要信息。
以JSON格式输出，包含 topic（主题）、stable_preferences（稳定偏好列表）、
temporary_states（临时状态列表）、confidence（置信度0-1）。

对话记录：
{chr(10).join(texts)}"""
    
    try:
        # 调用 Ollama 总结
        summary_res = requests.post(
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": SUMMARY_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False
            },
            timeout=60
        )
        summary_text = summary_res.json()["message"]["content"]
        
        # 存储为 insight
        insight_payload = {
            "text": summary_text,
            "timestamp": int(time.time() * 1000),
            "userId": shared,
            "conversationId": "auto_summary",
            "role": "assistant",
            "type": "insight",
            "source_ids": point_ids
        }
        
        # 生成向量
        embed_res = requests.post(
            f"{OLLAMA_URL}/api/embeddings",
            json={"model": "bge-m3:latest", "prompt": summary_text}
        )
        vector = embed_res.json()["embedding"]
        
        # 存入 Qdrant
        requests.put(
            f"{QDRANT_URL}/collections/{COLLECTION}/points?wait=true",
            json={
                "points": [{
                    "id": str(uuid.uuid4()),  # 需要 import uuid
                    "vector": vector,
                    "payload": insight_payload
                }]
            }
        )
        
        # 标记 raw 为已处理
        for pid in point_ids:
            requests.post(
                f"{QDRANT_URL}/collections/{COLLECTION}/points",
                json={"points": [{"id": pid, "payload": {"processed": True}}]}
            )
        
        logging.info(f"✅ 总结完成，处理 {len(point_ids)} 条 raw 记忆")
    except Exception as e:
        logging.error(f"❌ 总结失败: {e}")

def main_loop():
    """主循环，每 INTERVAL_HOURS 小时执行一次"""
    logging.info("自动总结服务启动")
    while True:
        try:
            raw_points = get_unprocessed_raw()
            if raw_points:
                logging.info(f"获取到 {len(raw_points)} 条未处理 raw 记忆")
                summarize_raw_batch(raw_points)
            else:
                logging.info("没有新记忆需要总结")
            
            # 等待下次执行
            time.sleep(INTERVAL_HOURS * 3600)
        except Exception as e:
            logging.error(f"循环异常: {e}")
            time.sleep(300)  # 出错后等5分钟再试

if __name__ == "__main__":
    import uuid  # 延迟导入，避免影响日志配置
    main_loop()