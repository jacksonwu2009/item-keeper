#!/usr/bin/env python3
"""用电脑上的 PaddleOCR 3.x（Paddle 推理）跑参考结果，给 compare.py 对照。

要一个装了 paddleocr（3.7）的 Python 环境，用那个环境的 python 跑这个脚本（不需要 ONNX）：
    <venv>/bin/python -I paddle_reference.py --out ref.json [--rotate-like ios.json] 照片...

- 模型 PP-OCRv6_small（det + rec），不开整图方向、行方向和矫正，检测、后处理参数用产线默认
  （短边 ≥ 64、长边 ≤ 4000，thresh 0.3、box_thresh 0.6、unclip 1.5），和手机端一样。
- --rotate-like：先按另一份结果（iOS / 安卓）里每张图的 rotation 把照片顺时针转好再识别，
  这样 PaddleOCR 的坐标和手机端在同一个坐标系里，可以逐行对照。
  注意这时 PaddleOCR 是在转正的图上做检测，手机端是在原图上检测、再按方向识别，侧着拍的图检测结果会不同。
- 照片按 EXIF 摆正后再识别（PaddleOCR 读图不看 EXIF，手机端看）。
"""
import argparse
import json
import tempfile
import time
from pathlib import Path

from PIL import Image, ImageOps
from paddleocr import PaddleOCR

parser = argparse.ArgumentParser()
parser.add_argument('--out', required=True)
parser.add_argument('--rotate-like')
parser.add_argument('photos', nargs='+')
args = parser.parse_args()

rotations = {}
if args.rotate_like:
    like = json.loads(Path(args.rotate_like).read_text(encoding='utf-8'))
    rotations = {name: value.get('rotation', 0) for name, value in like.items() if not name.startswith('_')}

engine = PaddleOCR(text_detection_model_name='PP-OCRv6_small_det', text_recognition_model_name='PP-OCRv6_small_rec',
                   use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False)
output = {'_meta': {'engine': 'PaddleOCR (Paddle inference)', 'rotate_like': args.rotate_like}}
# PIL 的 ROTATE_* 是逆时针
CLOCKWISE = {90: Image.ROTATE_270, 180: Image.ROTATE_180, 270: Image.ROTATE_90}
with tempfile.TemporaryDirectory() as work:
    for photo in map(Path, args.photos):
        rotation = rotations.get(photo.name, 0) or 0
        with Image.open(photo) as image:
            upright = ImageOps.exif_transpose(image).convert('RGB')
            if rotation in CLOCKWISE:
                upright = upright.transpose(CLOCKWISE[rotation])
            prepared = Path(work) / f'{photo.stem}.png'
            upright.save(prepared)
            width, height = upright.size
        started = time.perf_counter()
        prediction = list(engine.predict(str(prepared)))[0]
        elapsed_ms = (time.perf_counter() - started) * 1000
        lines = [{'text': text, 'score': round(float(score), 3), 'box': [[int(x), int(y)] for x, y in box]}
                 for text, score, box in zip(prediction['rec_texts'], prediction['rec_scores'], prediction['rec_polys'])
                 if text.strip()]
        output[photo.name] = {'lines': lines, 'width': width, 'height': height, 'rotation': rotation,
                              'elapsed_ms': round(elapsed_ms)}
        print(f'{photo.name}: 转 {rotation}°，{len(lines)} 行，{elapsed_ms:.0f} ms')
Path(args.out).write_text(json.dumps(output, ensure_ascii=False, indent=1), encoding='utf-8')
