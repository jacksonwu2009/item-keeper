#!/usr/bin/env python3
"""分阶段的参考数据：让手机端的检测后处理、识别各自吃和 PaddleOCR 完全相同的输入，单独对照每一段。

要一个装了 paddleocr（3.7）的 Python 环境：
    <venv>/bin/python -I paddle_stages.py --out <目录> [--rotate-like ios.json] 照片...

对每张照片（先按 EXIF 摆正，有 --rotate-like 时再按那份结果的 rotation 顺时针转）在 <目录>/<照片名>/ 下写：
- input.png：转好的整张图，手机端的检测在同一张图上跑，对照概率图
- prob.bin：PaddleOCR 检测模型输出的概率图（float32，按行），prob.json 记宽高、原图宽高，
  以及 PaddleX 的 DB 后处理（OpenCV findContours + pyclipper）在这张概率图上得到的框 → 对照手机端的 DbPostProcess
- crop-XXX.png：PaddleX 按它自己的框裁出来、转正的每一行小图（CropByPolys，warpPerspective），
  rec.json：PaddleOCR 识别模型对这些小图的结果 → 对照手机端的识别（预处理 + ONNX 推理 + CTC 解码）
- rec-XXX-input.bin / rec-XXX-output.bin：PaddleOCR 给识别模型的输入张量和模型输出（float32），
  手机端拿同一个输入跑 ONNX 模型 → 单独对照模型推理和 CTC 解码
"""
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps
from paddlex import create_model
from paddlex.inference.models.text_detection import processors as det_processors
from paddlex.inference.models.text_recognition import processors as rec_processors
from paddlex.inference.pipelines.components.common.crop_image_regions import CropByPolys
from paddlex.inference.pipelines.components.common.sort_boxes import SortQuadBoxes

parser = argparse.ArgumentParser()
parser.add_argument('--out', required=True)
parser.add_argument('--rotate-like')
parser.add_argument('photos', nargs='+')
args = parser.parse_args()

rotations = {}
if args.rotate_like:
    like = json.loads(Path(args.rotate_like).read_text(encoding='utf-8'))
    rotations = {name: value.get('rotation', 0) for name, value in like.items() if not name.startswith('_')}
CLOCKWISE = {90: Image.ROTATE_270, 180: Image.ROTATE_180, 270: Image.ROTATE_90}

# 检测：参数和产线一样（短边 ≥ 64、长边 ≤ 4000、thresh 0.3、box_thresh 0.6、unclip 1.5）
det = create_model('PP-OCRv6_small_det', limit_side_len=64, limit_type='min', max_side_limit=4000,
                   thresh=0.3, box_thresh=0.6, unclip_ratio=1.5)
rec = create_model('PP-OCRv6_small_rec')

# 截下 DB 后处理的输入（概率图）
captured = {}
original_call = det_processors.DBPostProcess.__call__


def capture(self, preds, img_shapes, *rest, **kwargs):
    captured['prob'] = np.array(preds[0][0][0], dtype=np.float32)
    captured['shape'] = [float(v) for v in img_shapes[0]]
    return original_call(self, preds, img_shapes, *rest, **kwargs)


det_processors.DBPostProcess.__call__ = capture

# 截下识别模型的输入张量和输出（每次只送一行）
original_batch = rec_processors.ToBatch.__call__
original_decode = rec_processors.CTCLabelDecode.__call__


def capture_batch(self, imgs):
    result = original_batch(self, imgs)
    captured['rec_input'] = np.array(result[0], dtype=np.float32)
    return result


def capture_decode(self, pred, *rest, **kwargs):
    captured['rec_output'] = np.array(pred[0], dtype=np.float32)
    return original_decode(self, pred, *rest, **kwargs)


rec_processors.ToBatch.__call__ = capture_batch
rec_processors.CTCLabelDecode.__call__ = capture_decode

out_root = Path(args.out)
for photo in map(Path, args.photos):
    rotation = rotations.get(photo.name, 0) or 0
    with Image.open(photo) as image:
        upright = ImageOps.exif_transpose(image).convert('RGB')
        if rotation in CLOCKWISE:
            upright = upright.transpose(CLOCKWISE[rotation])
    bgr = np.ascontiguousarray(np.array(upright)[:, :, ::-1])
    folder = out_root / photo.name
    folder.mkdir(parents=True, exist_ok=True)
    # 转好的整张图（PNG 无损），手机端的检测在同一张图上跑，对照概率图
    upright.save(folder / 'input.png')

    det_result = list(det.predict(bgr))[0]
    prob = captured['prob']
    prob.tofile(folder / 'prob.bin')
    boxes = [[[int(x), int(y)] for x, y in box] for box in det_result['dt_polys']]
    (folder / 'prob.json').write_text(json.dumps({
        'predW': int(prob.shape[1]), 'predH': int(prob.shape[0]),
        'srcW': int(bgr.shape[1]), 'srcH': int(bgr.shape[0]), 'rotation': rotation,
        'boxes': boxes, 'scores': [float(s) for s in det_result['dt_scores']],
    }, ensure_ascii=False), encoding='utf-8')

    sorted_boxes = SortQuadBoxes()(boxes) if boxes else []
    crops = list(CropByPolys(det_box_type='quad')(bgr, sorted_boxes)) if boxes else []
    entries = []
    for index, crop in enumerate(crops):
        name = f'crop-{index:03d}.png'
        Image.fromarray(np.ascontiguousarray(crop[:, :, ::-1])).save(folder / name)
        entries.append({'file': name, 'box': [[int(x), int(y)] for x, y in sorted_boxes[index]]})
    for index, (entry, crop) in enumerate(zip(entries, crops)):
        result = list(rec.predict([crop]))[0]
        entry['text'] = result['rec_text']
        entry['score'] = float(result['rec_score'])
        # 同一个输入张量给手机端的 ONNX 模型跑，对照模型本身（Paddle 推理 vs ONNX Runtime）
        captured['rec_input'].tofile(folder / f'rec-{index:03d}-input.bin')
        captured['rec_output'].tofile(folder / f'rec-{index:03d}-output.bin')
        entry['inputShape'] = list(captured['rec_input'].shape)
        entry['outputShape'] = list(captured['rec_output'].shape)
    (folder / 'rec.json').write_text(json.dumps(entries, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'{photo.name}: 概率图 {prob.shape[1]}×{prob.shape[0]}，{len(boxes)} 个框')
