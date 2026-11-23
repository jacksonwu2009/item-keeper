#!/usr/bin/env python3
"""逐行对照两份识别结果（iOS 测试工具的输出 vs 安卓的结果 / 电脑上 PaddleOCR 的结果）。

每份结果是 JSON：{ "照片文件名": { "lines": [ { "text", "score", "box": [[x,y]×4] } ], "width", "height", "rotation" } }，
也认 tests/fixtures/label-ocr/ 的 label-ocr-fixture/1 格式（items 按 id）和一张图一个文件的目录（见 load_results）。
照片名按不带扩展名配对（photo1.jpg 和 photo1 是同一张）。以 _ 开头的键忽略。

对照方法：
- 两边的行按框配对：框的外接矩形交并比（IoU）≥ 0.5 的，从大到小一对一配；
- 文字：完全一样算一致；另算字符级一致率（1 − 编辑距离 / 较长的长度）；
- 框：配上的两行四个角逐个比，取最大的像素差；
- 置信度：配上的两行差的绝对值。
两边的坐标系要一样（同一个 rotation、同一个宽高），不一样时先换算到 B 的坐标系。

用法：compare.py A.json B.json [--names A名=B名 ...] [--json 汇总输出.json] [--max-box-px 4] [--max-score-diff 0.05]
有门限参数时，超过门限或文字不一致就以非 0 退出（给 run-mac-tests.sh 判断用）。
"""
import argparse
import json
import sys
from pathlib import Path


def load_results(path):
    """读一份结果，返回 {照片名（不带扩展名）: 结果}"""
    path = Path(path)
    if path.is_dir():
        # 一张图一个文件：<照片名>.json，内容是一个 OcrResult（或者 {"result": OcrResult}）
        results = {}
        for file in sorted(path.glob('*.json')):
            data = json.loads(file.read_text(encoding='utf-8'))
            data = data.get('result', data)
            results[Path(data.get('photo') or data.get('name') or file.stem).stem] = data
        return results
    data = json.loads(path.read_text(encoding='utf-8'))
    if str(data.get('format', '')).startswith('label-ocr-fixture'):
        # tests/fixtures/label-ocr/ 的格式：items 里每项有 id、lines、width、height、rotation
        return {Path(item['id']).stem: item for item in data.get('items', [])}
    return {Path(key).stem: value for key, value in data.items() if not key.startswith('_')}


def bbox(box):
    xs = [point[0] for point in box]
    ys = [point[1] for point in box]
    return min(xs), min(ys), max(xs), max(ys)


def iou(box_a, box_b):
    ax0, ay0, ax1, ay1 = bbox(box_a)
    bx0, by0, bx1, by1 = bbox(box_b)
    inter_w = max(0, min(ax1, bx1) - max(ax0, bx0))
    inter_h = max(0, min(ay1, by1) - max(ay0, by0))
    inter = inter_w * inter_h
    union = (ax1 - ax0) * (ay1 - ay0) + (bx1 - bx0) * (by1 - by0) - inter
    return inter / union if union > 0 else 0.0


def edit_distance(a, b):
    previous = list(range(len(b) + 1))
    for i, char_a in enumerate(a, 1):
        current = [i]
        for j, char_b in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (char_a != char_b)))
        previous = current
    return previous[-1]


def to_frame(box, width, height, rotation_from, rotation_to):
    """把 A 的坐标（整张图顺时针转了 rotation_from 度）换到转了 rotation_to 度的坐标系"""
    def unrotate(x, y, w, h, rotation):
        # 转正后的点 → 原图的点；w、h 是转正后的宽高
        if rotation == 90:
            return y, w - x
        if rotation == 180:
            return w - x, h - y
        if rotation == 270:
            return h - y, x
        return x, y

    def rotate(x, y, w, h, rotation):
        # 原图的点 → 转了 rotation 后的点；w、h 是原图宽高
        if rotation == 90:
            return h - y, x
        if rotation == 180:
            return w - x, h - y
        if rotation == 270:
            return y, w - x
        return x, y

    if rotation_from == rotation_to:
        return box
    raw_w, raw_h = (height, width) if rotation_from in (90, 270) else (width, height)
    points = [unrotate(x, y, width, height, rotation_from) for x, y in box]
    return [list(rotate(x, y, raw_w, raw_h, rotation_to)) for x, y in points]


def compare_photo(result_a, result_b):
    lines_a = result_a.get('lines', [])
    lines_b = result_b.get('lines', [])
    rotation_a = result_a.get('rotation', 0) or 0
    rotation_b = result_b.get('rotation', 0) or 0
    width_a = result_a.get('width')
    height_a = result_a.get('height')
    boxes_a = [line['box'] for line in lines_a]
    if rotation_a != rotation_b and width_a and height_a:
        boxes_a = [to_frame(box, width_a, height_a, rotation_a, rotation_b) for box in boxes_a]
    pairs = []
    for index_a, box_a in enumerate(boxes_a):
        for index_b, line_b in enumerate(lines_b):
            overlap = iou(box_a, line_b['box'])
            if overlap >= 0.5:
                pairs.append((overlap, index_a, index_b))
    pairs.sort(reverse=True)
    used_a, used_b, matches = set(), set(), []
    for overlap, index_a, index_b in pairs:
        if index_a in used_a or index_b in used_b:
            continue
        used_a.add(index_a)
        used_b.add(index_b)
        matches.append((index_a, index_b, overlap))
    rows = []
    for index_a, index_b, overlap in sorted(matches, key=lambda item: item[1]):
        text_a = lines_a[index_a]['text']
        text_b = lines_b[index_b]['text']
        longest = max(len(text_a), len(text_b), 1)
        corner_px = max(
            max(abs(pa[0] - pb[0]), abs(pa[1] - pb[1])) for pa, pb in zip(boxes_a[index_a], lines_b[index_b]['box']))
        rows.append({
            'a': index_a, 'b': index_b, 'iou': round(overlap, 3),
            'text_a': text_a, 'text_b': text_b, 'same_text': text_a == text_b,
            'char_accuracy': 1 - edit_distance(text_a, text_b) / longest,
            'box_px': corner_px,
            'score_a': lines_a[index_a].get('score'), 'score_b': lines_b[index_b].get('score'),
            'score_diff': abs((lines_a[index_a].get('score') or 0) - (lines_b[index_b].get('score') or 0)),
        })
    only_a = [lines_a[i]['text'] for i in range(len(lines_a)) if i not in used_a]
    only_b = [lines_b[i]['text'] for i in range(len(lines_b)) if i not in used_b]
    chars_b = sum(len(line['text']) for line in lines_b)
    chars_matched = sum(row['char_accuracy'] * max(len(row['text_a']), len(row['text_b'])) for row in rows)
    return {
        'rotation': [rotation_a, rotation_b],
        'lines': [len(lines_a), len(lines_b)],
        'matched': len(rows),
        'same_text': sum(row['same_text'] for row in rows),
        'char_accuracy_matched': (sum(row['char_accuracy'] for row in rows) / len(rows)) if rows else None,
        'char_coverage_of_b': (chars_matched / chars_b) if chars_b else None,
        'max_box_px': max((row['box_px'] for row in rows), default=None),
        'mean_box_px': (sum(row['box_px'] for row in rows) / len(rows)) if rows else None,
        'max_score_diff': max((row['score_diff'] for row in rows), default=None),
        'only_a': only_a,
        'only_b': only_b,
        'rows': rows,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('a')
    parser.add_argument('b')
    parser.add_argument('--label-a', default='A')
    parser.add_argument('--label-b', default='B')
    parser.add_argument('--names', nargs='*', default=[], help='A 里的名字=B 里的名字')
    parser.add_argument('--json')
    parser.add_argument('--max-box-px', type=float)
    parser.add_argument('--max-score-diff', type=float)
    parser.add_argument('--quiet', action='store_true')
    args = parser.parse_args()

    results_a = load_results(args.a)
    results_b = load_results(args.b)
    mapping = dict(item.split('=', 1) for item in args.names)
    summary = {}
    ok = True
    for name_a in sorted(results_a):
        name_b = mapping.get(name_a, name_a)
        if name_b not in results_b:
            continue
        report = compare_photo(results_a[name_a], results_b[name_b])
        summary[name_a] = report
        line_a, line_b = report['lines']
        print(f"\n== {name_a}（{args.label_a} {line_a} 行，{args.label_b} {line_b} 行，配上 {report['matched']} 行，"
              f"文字一致 {report['same_text']} 行；转角 {report['rotation'][0]}° / {report['rotation'][1]}°）")
        if report['matched']:
            print(f"   字符一致率（配上的行）{report['char_accuracy_matched']:.3f}，"
                  f"框最大误差 {report['max_box_px']} px、平均 {report['mean_box_px']:.1f} px，"
                  f"置信度最大差 {report['max_score_diff']:.3f}")
        if not args.quiet:
            for row in report['rows']:
                mark = '＝' if row['same_text'] else '≠'
                detail = row['text_a'] if row['same_text'] else f"{row['text_a']}  |  {row['text_b']}"
                print(f"   {mark} 框差 {row['box_px']:>4} px  分 {row['score_a']} / {row['score_b']}  {detail}")
        for text in report['only_a']:
            print(f"   只有 {args.label_a}：{text}")
        for text in report['only_b']:
            print(f"   只有 {args.label_b}：{text}")
        if args.max_box_px is not None or args.max_score_diff is not None:
            if report['only_a'] or report['only_b'] or report['same_text'] != report['matched']:
                ok = False
            if args.max_box_px is not None and (report['max_box_px'] or 0) > args.max_box_px:
                ok = False
            if args.max_score_diff is not None and (report['max_score_diff'] or 0) > args.max_score_diff:
                ok = False
    if not summary:
        print('两份结果里没有同名的照片', file=sys.stderr)
        sys.exit(2)
    total_a = sum(r['lines'][0] for r in summary.values())
    total_b = sum(r['lines'][1] for r in summary.values())
    matched = sum(r['matched'] for r in summary.values())
    same = sum(r['same_text'] for r in summary.values())
    print(f"\n合计：{args.label_a} {total_a} 行，{args.label_b} {total_b} 行，配上 {matched} 行，文字一致 {same} 行")
    if args.json:
        Path(args.json).write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding='utf-8')
    if not ok:
        print('有超过门限的差异', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
