#!/usr/bin/env node
// 把拍照识别的两个模型（PP-OCRv6_small 的 det、rec，官方 FP32 ONNX）的权重压小，安装包里放压过的。
// scripts/fetch-ocr-models.sh 下载官方原版后调用这个脚本，并校验输出的 sha256。
//
// 只压权重，推理时算的还是 float32：
// - 卷积、全连接的权重存成 fp16，图里在权重前面加 Cast(fp16 → float)；
// - rec 最后一层全连接（linear_8，120 × 18710，把特征映射到 1 万 8 千多个字，占 rec 权重的四成多）存成 int8：
//   每个输出（每个字）沿输入方向每 12 个数一组，一组一个缩放系数（对称量化，float32），
//   图里加 Cast(int8 → float) → Mul(缩放系数) → Reshape → Transpose 还原成 [120, 18710]。
// ONNX Runtime 建会话时把这些只依赖常量的节点算掉（常量折叠，基本优化级别就做），得到 float32 权重，
// 之后每次推理和原模型走完全一样的算子，速度不变；用到的都是标准 ONNX 算子，安卓、iOS 的 ONNX Runtime 都支持。
//
// 为什么这样分：逐层试过（拿一批照片、截图、合成标签图，量化前后逐行比识别出的文字）——
// - 卷积全换成 int8（每通道一组，甚至每 8 个数一组）都会改掉不少字（「地址」认成「址」、「奥利奥」认成「奥利奧」）、
//   检测漏掉整行，只把最敏感的几十层留 fp16 也一样；fp16 和原模型几乎没差别。
// - 最后一层全连接用 int8 时，每个字一组会让空格变少（「+12 瓶」认成「+12瓶」）；每 12 个数一组以后和 fp16 一样。
//
// 只用 Node 自带的功能（不装任何包）：直接读写 ONNX 文件的 protobuf 编码；只有整数运算和 IEEE 浮点的基本运算，
// 同样的输入在任何机器上都得到逐字节一样的输出。
//
// 用法：node scripts/quantize-ocr-models.mjs <原版 inference.onnx> <输出 inference.onnx> <det|rec>

import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';

// ---------------------------------------------------------------- 量化方案

// 小于这个个数的权重不动（留 float32，省不了多少）
const MIN_ELEMENTS = 1024;
// 存 int8 的权重：名字 → 每组几个数（沿输入方向）
const INT8_WEIGHTS = {
  det: {},
  rec: { 'linear_8.w_0': 12 },
};

// ---------------------------------------------------------------- protobuf 编码读写

/** 读一个 varint，返回 [值(BigInt), 下一个位置] */
function readVarint(buffer, offset) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    const byte = buffer[offset++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, offset];
    shift += 7n;
  }
}

function encodeVarint(value) {
  let remaining = BigInt(value);
  if (remaining < 0n) remaining += 1n << 64n; // 负数按 64 位补码
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return Buffer.from(bytes);
}

/** 把一个 message 拆成字段列表：{ field, wire, value（varint 是 BigInt，长度前缀的是 Buffer）, raw（这个字段的原始字节） } */
function parseMessage(buffer) {
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    const [key, afterKey] = readVarint(buffer, offset);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    let value;
    offset = afterKey;
    if (wire === 0) {
      [value, offset] = readVarint(buffer, offset);
    } else if (wire === 2) {
      const [length, afterLength] = readVarint(buffer, offset);
      value = buffer.subarray(afterLength, afterLength + Number(length));
      offset = afterLength + Number(length);
    } else if (wire === 5) {
      value = buffer.subarray(offset, offset + 4);
      offset += 4;
    } else if (wire === 1) {
      value = buffer.subarray(offset, offset + 8);
      offset += 8;
    } else {
      throw new Error(`不认识的 protobuf 编码类型 ${wire}`);
    }
    fields.push({ field, wire, value, raw: buffer.subarray(start, offset) });
  }
  return fields;
}

function lengthField(field, payload) {
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(payload.length), payload]);
}

function varintField(field, value) {
  return Buffer.concat([encodeVarint(field << 3), encodeVarint(value)]);
}

function stringField(field, text) {
  return lengthField(field, Buffer.from(text, 'utf8'));
}

// onnx.proto 里的字段号和取值
const MODEL_GRAPH = 7;
const GRAPH_NODE = 1;
const GRAPH_INITIALIZER = 5;
const NODE_INPUT = 1;
const NODE_OUTPUT = 2;
const NODE_NAME = 3;
const NODE_OP_TYPE = 4;
const NODE_ATTRIBUTE = 5;
const ATTR_NAME = 1;
const ATTR_I = 3;
const ATTR_INTS = 8;
const ATTR_TYPE = 20;
const ATTR_TYPE_INT = 2;
const ATTR_TYPE_INTS = 7;
const TENSOR_DIMS = 1;
const TENSOR_DATA_TYPE = 2;
const TENSOR_NAME = 8;
const TENSOR_RAW_DATA = 9;
const DTYPE_FLOAT = 1;
const DTYPE_INT8 = 3;
const DTYPE_INT64 = 7;
const DTYPE_FLOAT16 = 10;

function text(value) {
  return Buffer.from(value).toString('utf8');
}

function parseTensor(raw) {
  const tensor = { dims: [], dataType: 0, name: '', rawData: null };
  for (const item of parseMessage(raw)) {
    if (item.field === TENSOR_DIMS) {
      if (item.wire === 0) {
        tensor.dims.push(Number(item.value));
      } else {
        // 打包编码的 repeated int64
        let offset = 0;
        while (offset < item.value.length) {
          const [dim, next] = readVarint(item.value, offset);
          tensor.dims.push(Number(dim));
          offset = next;
        }
      }
    } else if (item.field === TENSOR_DATA_TYPE) {
      tensor.dataType = Number(item.value);
    } else if (item.field === TENSOR_NAME) {
      tensor.name = text(item.value);
    } else if (item.field === TENSOR_RAW_DATA) {
      tensor.rawData = item.value;
    }
  }
  return tensor;
}

function initializerField(name, dims, dataType, rawData) {
  const tensor = Buffer.concat([
    ...dims.map((dim) => varintField(TENSOR_DIMS, dim)),
    varintField(TENSOR_DATA_TYPE, dataType),
    stringField(TENSOR_NAME, name),
    lengthField(TENSOR_RAW_DATA, rawData),
  ]);
  return lengthField(GRAPH_INITIALIZER, tensor);
}

/** attributes：{ 名字: 整数 | 整数数组 } */
function nodeField(name, opType, inputs, outputs, attributes = {}) {
  const encodedAttributes = Object.entries(attributes).map(([attribute, value]) => {
    const parts = [stringField(ATTR_NAME, attribute)];
    if (Array.isArray(value)) {
      // repeated int64 一个数一项（不打包）
      parts.push(...value.map((item) => varintField(ATTR_INTS, item)), varintField(ATTR_TYPE, ATTR_TYPE_INTS));
    } else {
      parts.push(varintField(ATTR_I, value), varintField(ATTR_TYPE, ATTR_TYPE_INT));
    }
    return lengthField(NODE_ATTRIBUTE, Buffer.concat(parts));
  });
  const node = Buffer.concat([
    ...inputs.map((input) => stringField(NODE_INPUT, input)),
    ...outputs.map((output) => stringField(NODE_OUTPUT, output)),
    stringField(NODE_NAME, name),
    stringField(NODE_OP_TYPE, opType),
    ...encodedAttributes,
  ]);
  return lengthField(GRAPH_NODE, node);
}

// ---------------------------------------------------------------- 数值

const float32View = new Float32Array(1);
const uint32View = new Uint32Array(float32View.buffer);

/** float32 → fp16 的位（四舍六入五成双，和 numpy 的 astype(float16) 一样） */
function toFloat16Bits(value) {
  float32View[0] = value;
  const bits = uint32View[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0); // 无穷大、NaN
  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 0x1f) return sign | 0x7c00; // 太大，成无穷大
  if (halfExponent <= 0) {
    // fp16 的非规格化数
    if (halfExponent < -10) return sign;
    mantissa |= 0x800000;
    const shift = 14 - halfExponent;
    const half = mantissa >>> shift;
    const remainder = mantissa & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    return sign | (remainder > halfway || (remainder === halfway && half & 1) ? half + 1 : half);
  }
  const half = (halfExponent << 10) | (mantissa >>> 13);
  const remainder = mantissa & 0x1fff;
  // 进位进到指数位也是对的（最大时变成无穷大）
  return sign | (remainder > 0x1000 || (remainder === 0x1000 && half & 1) ? half + 1 : half);
}

/** 四舍六入五成双（和 numpy.round 一样） */
function roundHalfEven(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * 分组的对称 int8 量化。weights 是 float32、按 dims 行优先排列，outAxis 是输出所在的维。
 * 先把输出维挪到最前面（[输出, 其余维摊平]），其余部分每 group 个数一组，一组一个缩放系数 = 组内最大绝对值 / 127。
 * 返回 q（[输出, 组数, group]）、scales（[输出, 组数, 1]）和挪过维以后的形状。
 */
function quantizeInt8(weights, dims, outAxis, group) {
  const outCount = dims[outAxis];
  const inner = dims.slice(outAxis + 1).reduce((a, b) => a * b, 1);
  const perOutput = weights.length / outCount;
  if (perOutput % group !== 0) throw new Error(`每组 ${group} 个数分不均（每个输出 ${perOutput} 个）`);
  const groups = perOutput / group;
  // 第 output 个输出的第 k 个数（k 是挪走输出维以后的行优先序号）在原数组里的位置
  const indexOf = (output, k) => (Math.floor(k / inner) * outCount + output) * inner + (k % inner);
  const q = new Int8Array(weights.length);
  const scales = new Float32Array(outCount * groups);
  for (let output = 0; output < outCount; output++) {
    for (let g = 0; g < groups; g++) {
      let maxAbs = 0;
      for (let k = g * group; k < (g + 1) * group; k++) maxAbs = Math.max(maxAbs, Math.abs(weights[indexOf(output, k)]));
      // 和 float32 里算 maxAbs / 127 一样（双精度算完再舍入到 float32，结果相同）
      const scale = maxAbs > 0 ? Math.fround(maxAbs / 127) : 1;
      scales[output * groups + g] = scale;
      for (let k = g * group; k < (g + 1) * group; k++) {
        const ratio = Math.fround(weights[indexOf(output, k)] / scale);
        q[output * perOutput + k] = Math.max(-127, Math.min(127, roundHalfEven(ratio)));
      }
    }
  }
  const movedDims = [outCount, ...dims.filter((_, index) => index !== outAxis)];
  return { q, qDims: [outCount, groups, group], scales, scaleDims: [outCount, groups, 1], movedDims };
}

// ---------------------------------------------------------------- 改图

function float16Weight(tensor, weights) {
  const half = Buffer.alloc(weights.length * 2);
  for (let index = 0; index < weights.length; index++) half.writeUInt16LE(toFloat16Bits(weights[index]), index * 2);
  return {
    initializers: [initializerField(`${tensor.name}_f16`, tensor.dims, DTYPE_FLOAT16, half)],
    nodes: [nodeField(`${tensor.name}_cast`, 'Cast', [`${tensor.name}_f16`], [tensor.name], { to: DTYPE_FLOAT })],
  };
}

function int8Weight(tensor, weights, opType, group) {
  const name = tensor.name;
  // Conv 权重 [O, I, kh, kw] 输出在第 0 维；ConvTranspose [I, O/g, kh, kw] 和 MatMul [K, N] 在第 1 维
  const outAxis = opType === 'Conv' ? 0 : 1;
  const { q, qDims, scales, scaleDims, movedDims } = quantizeInt8(weights, tensor.dims, outAxis, group);
  const scaleBytes = Buffer.alloc(scales.length * 4);
  scales.forEach((scale, index) => scaleBytes.writeFloatLE(scale, index * 4));
  const shapeBytes = Buffer.alloc(movedDims.length * 8);
  movedDims.forEach((dim, index) => shapeBytes.writeBigInt64LE(BigInt(dim), index * 8));
  const reshaped = outAxis === 0 ? name : `${name}_moved`;
  const nodes = [
    nodeField(`${name}_cast`, 'Cast', [`${name}_q8`], [`${name}_q8f`], { to: DTYPE_FLOAT }),
    nodeField(`${name}_mul`, 'Mul', [`${name}_q8f`, `${name}_scale`], [`${name}_deq`]),
    nodeField(`${name}_reshape`, 'Reshape', [`${name}_deq`, `${name}_shape`], [reshaped]),
  ];
  if (outAxis !== 0) {
    // 把输出维挪回原来的位置：perm 是 [1, 2, …]，在 outAxis 处插入 0
    const perm = movedDims.map((_, index) => index).slice(1);
    perm.splice(outAxis, 0, 0);
    nodes.push(nodeField(`${name}_transpose`, 'Transpose', [reshaped], [name], { perm }));
  }
  return {
    initializers: [
      initializerField(`${name}_q8`, qDims, DTYPE_INT8, Buffer.from(q.buffer)),
      initializerField(`${name}_scale`, scaleDims, DTYPE_FLOAT, scaleBytes),
      initializerField(`${name}_shape`, [movedDims.length], DTYPE_INT64, shapeBytes),
    ],
    nodes,
  };
}

function compressModel(input, part) {
  const int8Weights = INT8_WEIGHTS[part];
  if (!int8Weights) throw new Error(`第三个参数应该是 det 或 rec：${part}`);
  const modelFields = parseMessage(input);
  const graphIndex = modelFields.findIndex((item) => item.field === MODEL_GRAPH);
  const graphFields = parseMessage(modelFields[graphIndex].value);

  // 每个名字被哪些算子、当第几个输入用
  const uses = new Map();
  for (const item of graphFields) {
    if (item.field !== GRAPH_NODE) continue;
    let opType = '';
    const inputs = [];
    for (const field of parseMessage(item.value)) {
      if (field.field === NODE_OP_TYPE) opType = text(field.value);
      if (field.field === NODE_INPUT) inputs.push(text(field.value));
    }
    inputs.forEach((name, index) => {
      if (!uses.has(name)) uses.set(name, []);
      uses.get(name).push({ opType, index });
    });
  }

  const newNodes = [];
  const keptFields = [];
  const newInitializers = [];
  const summary = { int8: 0, fp16: 0, float32: 0 };
  const int8Done = new Set();
  for (const item of graphFields) {
    if (item.field !== GRAPH_INITIALIZER) {
      keptFields.push(item.raw);
      continue;
    }
    const tensor = parseTensor(item.value);
    const used = uses.get(tensor.name) ?? [];
    const elements = tensor.dims.reduce((a, b) => a * b, 1);
    const isWeight =
      used.length > 0 && used.every((use) => ['Conv', 'ConvTranspose', 'MatMul'].includes(use.opType) && use.index === 1);
    if (!isWeight || tensor.dataType !== DTYPE_FLOAT || !tensor.rawData || elements < MIN_ELEMENTS) {
      keptFields.push(item.raw);
      summary.float32 += elements;
      continue;
    }
    // ONNX 的 raw_data 是小端
    const weights = new Float32Array(elements);
    for (let index = 0; index < elements; index++) weights[index] = tensor.rawData.readFloatLE(index * 4);
    const group = int8Weights[tensor.name];
    const replaced = group ? int8Weight(tensor, weights, used[0].opType, group) : float16Weight(tensor, weights);
    newNodes.push(...replaced.nodes);
    newInitializers.push(...replaced.initializers);
    if (group) {
      int8Done.add(tensor.name);
      summary.int8 += elements;
    } else {
      summary.fp16 += elements;
    }
  }
  const missing = Object.keys(int8Weights).filter((name) => !int8Done.has(name));
  if (missing.length > 0) throw new Error(`模型里没有要存 int8 的权重：${missing.join('、')}（模型换了？）`);

  // 新节点放在所有原节点前面（只依赖常量，放前面拓扑顺序就对），新初始化器放最后
  const graph = Buffer.concat([...newNodes, ...keptFields, ...newInitializers]);
  const model = Buffer.concat(modelFields.map((item, index) => (index === graphIndex ? lengthField(MODEL_GRAPH, graph) : item.raw)));
  return { model, summary };
}

// ---------------------------------------------------------------- 入口

const [source, target, part] = process.argv.slice(2);
if (!source || !target || !part) {
  console.error('用法：node scripts/quantize-ocr-models.mjs <原版 inference.onnx> <输出 inference.onnx> <det|rec>');
  process.exit(2);
}
const input = readFileSync(source);
const { model, summary } = compressModel(input, part);
writeFileSync(target, model);
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
console.log(
  `  ${part}：${summary.fp16} 个权重存 fp16，${summary.int8} 个存 int8，${summary.float32} 个不动；` +
    `${mb(input.length)} → ${mb(model.length)}`,
);
