#!/usr/bin/env python3
"""
生成发给同事看的使用指南。

仓库里的 docs/user-guide.html 是公开版：同事名字、Expo Go 地址这类只给自己人看的内容，
写成 <span data-local="键">通用说法</span>。本脚本读 docs/guide.local.json（不进仓库），
把这些 span 里的文字换成真实内容，输出 docs/user-guide.local.html（也不进仓库），发布用这个文件。

docs/guide.local.json 示例：
  {"ios-packager": "同事某某", "expo-where": "就在下面", "expo-url": "这个地址 <code>exp://…</code>"}

用法：python3 scripts/render-guide.py
"""
import json
import pathlib
import re
import sys

root = pathlib.Path(__file__).resolve().parent.parent
source = root / 'docs' / 'user-guide.html'
values_file = root / 'docs' / 'guide.local.json'
target = root / 'docs' / 'user-guide.local.html'

values = json.loads(values_file.read_text(encoding='utf-8'))
html = source.read_text(encoding='utf-8')
used = set()


def replace(match: re.Match) -> str:
    key = match.group(1)
    if key not in values:
        return match.group(0)
    used.add(key)
    return f'<span data-local="{key}">{values[key]}</span>'


rendered = re.sub(r'<span data-local="([\w-]+)">(.*?)</span>', replace, html, flags=re.S)
missing = sorted(set(re.findall(r'data-local="([\w-]+)"', html)) - used)
if missing:
    sys.exit(f'docs/guide.local.json 里缺这些键：{", ".join(missing)}')
target.write_text(rendered, encoding='utf-8')
print(f'已生成 {target.relative_to(root)}，替换了 {len(used)} 种内容')
