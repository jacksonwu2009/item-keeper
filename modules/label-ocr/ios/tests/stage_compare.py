#!/usr/bin/env python3
"""分阶段对照：paddle_stages.py 的输出（PaddleOCR）和 label-ocr-stages 的输出（手机端引擎）逐段比。

用法：stage_compare.py <paddle_stages 输出目录> <label-ocr-stages 输出.json> [--json 汇总.json]
"""
import argparse
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location('compare', Path(__file__).with_name('compare.py'))
compare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compare)


def match_boxes(ours, theirs):
    lines_a = [{'text': '', 'box': box} for box in ours]
    lines_b = [{'text': '', 'box': box} for box in theirs]
    report = compare.compare_photo({'lines': lines_a}, {'lines': lines_b})
    return {
        'ours': len(ours), 'paddle': len(theirs), 'matched': report['matched'],
        'max_box_px': report['max_box_px'], 'mean_box_px': report['mean_box_px'],
        'per_box_px': [row['box_px'] for row in report['rows']],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('stages')
    parser.add_argument('ours')
    parser.add_argument('--json')
    args = parser.parse_args()
    ours = json.loads(Path(args.ours).read_text(encoding='utf-8'))
    summary = {}
    totals = {'rec_lines': 0, 'rec_same': 0, 'rec_chars': 0, 'rec_char_errors': 0}
    for photo in sorted(ours):
        folder = Path(args.stages) / photo
        meta = json.loads((folder / 'prob.json').read_text(encoding='utf-8'))
        paddle_rec = json.loads((folder / 'rec.json').read_text(encoding='utf-8'))
        entry = ours[photo]
        print(f'\n== {photo}（概率图 {meta["predW"]}×{meta["predH"]}）')

        prob = entry.get('prob', {})
        if 'maxAbsDiff' in prob:
            print(f'   检测模型输出：最大差 {prob["maxAbsDiff"]:.4f}，平均差 {prob["meanAbsDiff"]:.5f}，'
                  f'二值化后不同的点 {prob["maskFlips"]} / 前景 {prob["foreground"]}')
        else:
            print(f'   检测模型输出：{prob.get("error")}')

        db = match_boxes(entry['dbBoxes'], meta['boxes'])
        print(f'   后处理（同一张概率图）：手机端 {db["ours"]} 个框，PaddleX {db["paddle"]} 个，配上 {db["matched"]}，'
              f'角点最大差 {db["max_box_px"]} px、平均 {db["mean_box_px"]:.2f} px；每个框 {db["per_box_px"]}')
        own = None
        if 'ownBoxes' in entry:
            own = match_boxes(entry['ownBoxes'], meta['boxes'])
            print(f'   整段检测（手机端缩放 + 模型 + 后处理）：{own["ours"]} 个框，PaddleOCR {own["paddle"]} 个，'
                  f'配上 {own["matched"]}，角点最大差 {own["max_box_px"]} px、平均 {own["mean_box_px"]:.2f} px')

        rec_rows = []
        for mine, theirs in zip(entry['rec'], paddle_rec):
            text_a = mine.get('text', '')
            text_b = theirs.get('text', '')
            errors = compare.edit_distance(text_a, text_b)
            rec_rows.append({'file': theirs['file'], 'ours': text_a, 'paddle': text_b, 'same': text_a == text_b,
                             'edit_distance': errors, 'score_ours': mine.get('score'),
                             'score_paddle': round(theirs.get('score', 0), 3)})
            totals['rec_lines'] += 1
            totals['rec_same'] += text_a == text_b
            totals['rec_chars'] += max(len(text_b), 1)
            totals['rec_char_errors'] += errors
        same = sum(row['same'] for row in rec_rows)
        score_diff = max((abs((row['score_ours'] or 0) - row['score_paddle']) for row in rec_rows), default=0)
        print(f'   识别（同样的行小图）：{len(rec_rows)} 行，文字一致 {same} 行，置信度最大差 {score_diff:.3f}')
        for row in rec_rows:
            if not row['same']:
                print(f'     ≠ {row["ours"]}（{row["score_ours"]}）  |  {row["paddle"]}（{row["score_paddle"]}）')
        model_rows = entry.get('recModel', [])
        if model_rows:
            max_diff = max(row.get('maxAbsDiff', float('inf')) for row in model_rows)
            same_ort = sum(row.get('ortText') == row.get('paddleText') for row in model_rows)
            same_decode = sum(row.get('paddleOutputText') == row.get('paddleText') for row in model_rows)
            print(f'   识别模型（同一个输入张量）：{len(model_rows)} 行，ONNX 和 Paddle 输出最大差 {max_diff:.2e}；'
                  f'ONNX 输出解码后文字和 PaddleOCR 一致 {same_ort} 行；Paddle 输出用手机端 CTC 解码一致 {same_decode} 行')
            totals['model_lines'] = totals.get('model_lines', 0) + len(model_rows)
            totals['model_same'] = totals.get('model_same', 0) + same_ort
            totals['decode_same'] = totals.get('decode_same', 0) + same_decode
            totals['model_max_diff'] = max(totals.get('model_max_diff', 0), max_diff)
        summary[photo] = {'prob': prob, 'db': db, 'det': own, 'rec': rec_rows, 'rec_model': model_rows}

    char_accuracy = 1 - totals['rec_char_errors'] / max(totals['rec_chars'], 1)
    print(f'\n识别合计：{totals["rec_lines"]} 行，文字一致 {totals["rec_same"]} 行，字符一致率 {char_accuracy:.4f}')
    if 'model_lines' in totals:
        print(f'识别模型合计：{totals["model_lines"]} 行，ONNX 输出和 Paddle 输出最大差 {totals["model_max_diff"]:.2e}，'
              f'ONNX 解码文字一致 {totals["model_same"]} 行，CTC 解码一致 {totals["decode_same"]} 行')
    if args.json:
        Path(args.json).write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding='utf-8')


if __name__ == '__main__':
    main()
