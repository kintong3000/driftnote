#!/usr/bin/env python3
"""把一份 Markdown 知识总结通过 driftnote 的 /api/capture 存进 Notion（只用标准库）。

环境变量与终端命令 note 一致：
  NOTE_ENDPOINT   driftnote Worker 地址，如 https://driftnote.xxx.workers.dev
  NOTE_TOKEN      接口密钥（X-Auth-Token）
  NOTE_SOURCE     来源，默认 claude-code

用法：
  python3 save_to_notion.py [--title 标题] [--type 类型] FILE.md
  cat note.md | python3 save_to_notion.py -
  python3 save_to_notion.py --check

- 标题默认取正文第一个「# 标题」（并从正文中去掉）。
- 「内容」属性取正文第一段引用（一句话结论），完整总结按 Markdown 渲染进页面正文，
  服务端会顺带生成 AI 摘要。
- 发送失败时把请求追加到 ~/.note_failed.jsonl，和 note 共用，可以用 note-retry 重发。
"""
import argparse
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request
import uuid

ENDPOINT = os.environ.get("NOTE_ENDPOINT", "").rstrip("/")
TOKEN = os.environ.get("NOTE_TOKEN", "")
SOURCE = os.environ.get("NOTE_SOURCE", "claude-code")
FAILED = os.path.expanduser("~/.note_failed.jsonl")


def ssl_context():
    """python.org 版 Python 在 macOS 上常缺根证书：依次尝试 certifi、系统证书文件。"""
    ctx = ssl.create_default_context()
    if ctx.get_ca_certs():
        return ctx
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    for path in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt", "/opt/homebrew/etc/ca-certificates/cert.pem"):
        if os.path.exists(path):
            return ssl.create_default_context(cafile=path)
    return ctx


def post(payload):
    req = urllib.request.Request(
        f"{ENDPOINT}/api/capture",
        method="POST",
        data=json.dumps(payload, ensure_ascii=False).encode(),
        # Cloudflare 会拦截默认的 Python-urllib UA（403 / error 1010），换成自定义 UA
        headers={"Content-Type": "application/json", "X-Auth-Token": TOKEN, "User-Agent": "driftnote-knowledge/1.0"},
    )
    with urllib.request.urlopen(req, timeout=60, context=ssl_context()) as res:
        return json.loads(res.read() or b"{}")


def split(md, title):
    """返回 (标题, 一句话结论, 正文)。"""
    md = md.strip()
    m = re.match(r"^#\s+(.+)\n?", md)
    if m:
        title = title or m.group(1).strip()
        md = md[m.end():].lstrip()
    quote = re.search(r"^>\s?(.+)$", md, re.M)
    lead = re.sub(r"\*\*|`", "", quote.group(1)).strip() if quote else ""
    lead = re.sub(r"^(一句话)?(结论|TL;DR)[:：]\s*", "", lead, flags=re.I)
    title = title or md.splitlines()[0].lstrip("#> ").strip()
    return title, lead or title, md


def queue(payload, reason):
    with open(FAILED, "a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.exit(f"✗ 发送失败（{reason}），已加入 {FAILED}，稍后运行 note-retry 重发")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", nargs="?", help="Markdown 文件，- 表示从标准输入读")
    ap.add_argument("--title", help="标题（driftnote 最多保留 60 字）")
    ap.add_argument("--type", default="AI对话", help="driftnote 的类型，默认 AI对话")
    ap.add_argument("--check", action="store_true", help="只检查环境变量")
    a = ap.parse_args()

    if not ENDPOINT or not TOKEN:
        sys.exit("未设置 NOTE_ENDPOINT / NOTE_TOKEN（与终端命令 note 共用同一套配置）")
    if a.check:
        print(f"✓ NOTE_ENDPOINT={ENDPOINT}  NOTE_SOURCE={SOURCE}")
        return

    if a.file in (None, "-"):
        md = sys.stdin.read()
    else:
        with open(a.file, encoding="utf-8") as f:
            md = f.read()
    if not md.strip():
        sys.exit("正文为空")

    title, lead, body = split(md, a.title)
    payload = {
        "text": lead,
        "title": title,
        "type": a.type,
        "source": SOURCE,
        "id": str(uuid.uuid4()).upper(),
        "content": body,
        "contentHeading": "知识总结",
        "markdown": True,
        "fetch": False,
    }
    try:
        r = post(payload)
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get("error", e.reason)
        except Exception:
            msg = e.reason
        if e.code in (400, 401):  # 请求本身有问题，重发也没用
            sys.exit(f"✗ {e.code}: {msg}" + ("（检查 NOTE_TOKEN）" if e.code == 401 else ""))
        return queue(payload, f"{e.code}: {msg}")
    except (urllib.error.URLError, TimeoutError) as e:
        return queue(payload, getattr(e, "reason", e))
    print(f"✓ 已保存（{r.get('type', a.type)}）：{r.get('title', title)}\n{r.get('url', '')}")


if __name__ == "__main__":
    main()
