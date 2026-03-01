import sys
import jieba
import re

if __name__ == "__main__":
    # 从标准输入读取文本
    text = sys.stdin.read().strip()
    if not text:
        sys.exit(0)
    
    # 使用 jieba 精确模式分词
    words = jieba.cut(text)
    
    # 过滤：只保留长度≥2且不是纯数字的词
    for w in words:
        w = w.strip()
        if len(w) >= 2 and not re.fullmatch(r'\d+', w):
            print(w)