/**
 * 拍照识别：从包装上认出的一行行文字里找名称、规格、保质期和日期。
 *
 * 只依赖「一行行文字 + 位置 + 置信度」，不管是哪个识别引擎认的（安卓、iOS 用 PaddleOCR，鸿蒙用系统识别），
 * 三端用同一套规则（鸿蒙移植到 common/src/main/ets/lib/LabelParse.ets），用同一批测试数据：
 * tests/fixtures/label-ocr/（格式见那里的 README.md）。
 *
 * 规则（方案第四节、第九节「规则要补」）：
 * - 名称：「产品名称 / 食品名称 / 品名 / 名称：」后面的字，遇到下一个字段名就截断；没有时不猜，
 *   把标签上字最大的几行列成候选让人点。
 * - 规格：「净含量 / 规格：」后面带单位的数（g、kg、mL、L、克、千克、毫升、升、片、抽、张、袋、支……，可带「×12」），
 *   没有单位的不采用。
 * - 保质期：「保质期：12个月 / 180天 / 2年 / 三年」，中文数字也认；「保质期至」后面是到期日，不是保质期。
 * - 生产日期：写「见瓶盖 / 见封口 / 见喷码 / 见包装」时记下来，界面提示单独拍喷码；
 *   日期认 2026.10.12、2026-10-12、2026/10/12、20261012、2026年10月12日。
 *   旁边写「生产 / MFG / PD」的是生产日期，写「保质期至 / 有效期至 / EXP / BB」的是到期日：
 *   先看同一行日期前面的字，再按位置找离它最近的那一行字（同一排左边、或正上方）。
 *   旁边没写字、同一行日期后面跟着时间（「20260930EA1 14:09」，中间可以夹批号）的，当生产日期。
 * - 合理性：生产日期不晚于今天、不早于 5 年前；两个日期正好差一个保质期时互相印证。
 * - 日期怎么填（decideDates）：
 *   - 写着「生产」「保质期至」、能分清的直接填。知道保质期（商品资料里的或标签上认出的）时，生产日期和到期日
 *     正好差一个保质期就互相印证；对不上就列出来让人选。
 *   - 不知道保质期、两个日期旁边都没写字：前一个不晚于今天、后一个在今天以后、比前一个晚 7 天到 5 年时，
 *     前面的填生产日期、后面的填到期日，标「按先后填的」让人核对。
 *   - 不知道保质期、认出了生产日期（写着「生产」或后面跟着时间），另外只有一个没写字的日期，在今天以后、
 *     比生产日期晚 7 天到 5 年：当到期日，也标「按先后填的」。
 *   - 只有一个日期：填进点了「拍日期」的那一格；在今天以后的一定是到期日，后面跟着时间的是生产日期。
 *   - 别的情况列出来让人选，不猜：三个及以上、两个都在今天以后、两个都不晚于今天、隔得太近或太远、前面的反而晚。
 *     其中写着「生产」的生产日期照填、另外的日期不填；生产日期只是看时间认的，就和都没写字时一样列出来。
 * - 容错：识别时偶尔漏字、认错一个字（「质期」「生产口期」「品名称」），关键词按容错写；
 *   「见包装检验合格」这类连写在下一个字段名处截断。
 */

import { addYears, diffDays, expiryFromShelfLife, isValidDateStr, type ShelfLife, type ShelfLifeUnit } from './dates';

export type { ShelfLife };

// ───────────────────────────── 输入、输出 ─────────────────────────────

/** 识别引擎给的一行字。box 是四个角 [x, y]（左上、右上、右下、左下），没有位置信息时可以不给；score 没有时当 1 */
export type LabelLine = {
  text: string;
  score?: number | null;
  box?: [number, number][] | null;
};

export type DateRole = 'production' | 'expiry';

/** 认出的一个日期 */
export type LabelDate = {
  /** YYYY-MM-DD */
  date: string;
  /** 旁边的字（或后面跟着的时间）说明了是生产日期还是到期日；分不清是 null */
  role: DateRole | null;
  /** 在第几行（输入 lines 的下标） */
  line: number;
  /** 旁边没写字，是看同一行日期后面跟着时间（14:09）才当生产日期的 */
  byTime: boolean;
};

export type LabelQuality = {
  /** 置信度 ≥ 0.5、至少两个字的行数 */
  usableLines: number;
  /** 这些行的平均置信度（没有时是 0） */
  meanScore: number;
  /** 一行像样的字都没有，或平均置信度低于 0.7：照片糊、暗、反光，提示重拍 */
  poor: boolean;
};

export type LabelParseResult = {
  name: string | null;
  /** 名称拿不准时给人点选的候选：标签上字明显大的几行（不含已经填进 name 的） */
  nameCandidates: string[];
  spec: string | null;
  shelfLife: ShelfLife | null;
  /** 标签上写着生产日期印在别处，例如「见瓶盖」「见包装喷码处」：要单独拍喷码 */
  dateElsewhere: string | null;
  /** 认出的合理日期（今天前 5 年到今天后 10 年），按出现顺序，同一天只留一个 */
  dates: LabelDate[];
  quality: LabelQuality;
};

// ───────────────────────────── 关键词 ─────────────────────────────

/**
 * 标签上常见的字段名。用来截断：名称、「见包装」这些值遇到下一个字段名就停。
 * 长的放前面（「产品名称」先于「名称」），按容错写的放在 FIELD_CUT_RE 里。
 */
const FIELD_WORDS = [
  '产品名称', '食品名称', '商品名称', '品名',
  '主要原料', '原料', '配料表', '配料', '成分',
  '产品编号', '产品类型', '产品标准号', '产品标准代号', '执行标准', '卫生标准', '标准号', '质量等级', '等级', '香型',
  '规格', '净含量', '净重', '保质期', '生产日期', '生产批号', '批号', '日期',
  '贮存条件', '储存条件', '贮存方法', '储存方法', '保存条件', '保存方法', '食用方法', '使用方法', '注意事项', '温馨提示',
  '致敏物质', '过敏原', '营养成分',
  '生产商', '制造商', '生产者', '经销商', '责任单位', '委托方', '受委托方', '受托方', '委托单位', '被委托方',
  '地址', '产地', '原产地', '电话', '服务热线', '消费者服务热线', '咨询电话', '邮政编码', '网址',
  '食品生产许可证', '生产许可证', '检验合格', '合格',
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 字段名出现的地方（截断用）：已知字段名，或「空格 / 圆点 后面跟 2–6 个汉字再跟冒号」这种样子的不认识的字段名 */
const FIELD_CUT_RE = new RegExp(
  `${[...FIELD_WORDS].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')}|质期|生产[口曰目]期|[\\s●•·][\\u4e00-\\u9fa5]{2,6}:`,
);

/** 圆点、分号这些分隔符：值到这里为止 */
const SEPARATOR_RE = /[●•·;；|]/;

/** 名称：产品名称 / 食品名称 / 商品名称 / 品名称（漏了「产」）/ 品名；光写「名称」的要在一段开头 */
const NAME_KEY_RE = /(?:[产食商]品名称|品名称|品\s*名)\s*:?|(?:^|[\s●•·、,，;；])名\s*称\s*:/;

/** 规格的字段名 */
const SPEC_KEY_RE = /净\s*含\s*量|净\s*重|规\s*格|容\s*量/g;
const SPEC_VALUE_RE =
  /^\s*:?\s*(\d+(?:\.\d+)?)\s*(千克|公斤|毫升|kg|mg|ml|g|l|克|升|片|抽|张|包|袋|支|粒|枚|卷|节|瓶|盒|罐|条|只)(?:\s*[x×*]\s*(\d+)\s*(片|抽|张|包|袋|支|粒|枚|卷|节|瓶|盒|罐|条|只|个)?)?/i;

/**
 * 保质期：保质期 / 质期（漏了「保」或认错成别的字）/ 保存期 / 保质期限，后面跟数字和单位；后面是「至」的是到期日，不算。
 * 数字可以是阿拉伯数字或中文数字。
 */
const SHELF_RE =
  /(?:保\s*质\s*期\s*限|保\s*存\s*期\s*限|质\s*期|保\s*存\s*期|保\s*质)(?!\s*至)(?:\s*[(（][^)）]{0,8}[)）])?\s*:?\s*(?:为|是)?\s*(\d{1,4}|[零〇一二两三四五六七八九十百]{1,4})\s*(个\s*月|月|年|天|日)/;
const SHELF_EN_RE = /shelf\s*life\s*:?\s*(\d{1,4})\s*(months?|days?|years?)/i;

/** 「生产日期：见瓶盖」「生产日期及批号：见封口处」「日期：见包装」 */
const ELSEWHERE_RE = /(?:生\s*产\s*[日口曰目]?\s*期|生\s*产\s*批\s*号|日\s*期)[^:见\s]{0,5}\s*:?\s*(见[^\s●•·,，。;；:]{1,12})/;
const ELSEWHERE_PLACE_RE = /瓶|盖|封|喷码|包装|袋|盒|底|侧|顶|边|标|印|罐|口/;

/**
 * 日期前后表示「生产日期」的字。光写「生产」的只在后面紧跟数字时算（「生产商」「生产许可证」不算）；
 * PD、BB 这种字母缩写前后不能挨着别的字母。
 */
const PRODUCTION_KEY_RE =
  /生\s*产\s*[日口曰目]\s*期|生\s*产\s*批\s*号|生\s*产\s*时\s*间|生\s*产(?=[\s:]*\d)|产\s*日\s*期|制\s*造\s*日\s*期|包\s*装\s*日\s*期|MFG|MFD|PROD|(?:^|[^A-Z])P\.?D(?![A-Z])/gi;
/** 表示「到期日」的字；光写「保质期」的只在后面紧跟 20xx 年的日期时算（「保质期：12个月」是保质期） */
const EXPIRY_KEY_RE =
  /保\s*质\s*期\s*至|有\s*效\s*期\s*至|保\s*质\s*至|有\s*效\s*期|到\s*期|失\s*效|限\s*用|保\s*质\s*期(?=[\s:]*20\d{2})|EXP|BEST\s*BEFORE|USE\s*BY|(?:^|[^A-Z])BBE?(?![A-Z])/gi;

/** 2026.10.12 / 2026-10-12 / 2026/10/12 / 2026年10月12日（分隔符前后可以有空格） */
const DATE_SEP_RE = /(^|\D)(20\d{2})\s*[.\-/年]\s*(\d{1,2})\s*[.\-/月]\s*(\d{1,2})(?!\d)/g;
/** 20261012，后面可以紧跟 0–4 位（时间、班次，例如 2026092411）；一串数字超过 12 位的多半是条码、许可证号，不认 */
const DATE_COMPACT_RE = /(^|\D)(20\d{2})(\d{2})(\d{2})(\d{0,4})(?!\d)/g;
/**
 * 日期后面紧跟着的时间：14:09、14:09:33；中间可以夹批号（字母、数字、空格、横杠，最多 12 个，最后一个不是数字），
 * 例如「20260930EA1 14:09」「2026093014:09」。印着时间的一般是生产时刻。
 */
const TIME_AFTER_DATE_RE = /^(?:[\sA-Za-z0-9-]{0,12}?[\sA-Za-z-])?(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?!\d)/;

// ───────────────────────────── 小工具 ─────────────────────────────

/** 全角字母数字、冒号转半角，去掉零宽字符；空格保留（截断要用） */
export function normalizeText(text: string): string {
  return text
    .replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .replace(/[​-‍﻿]/g, '')
    .replace(/[：︰]/g, ':')
    .trim();
}

const CHINESE_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 中文数字（到九百九十九）：三、十二、二十四、一百八十；认不出返回 null */
export function parseChineseNumber(text: string): number | null {
  if (/^\d+$/.test(text)) return Number(text);
  let total = 0;
  let current = 0;
  let seenAny = false;
  for (const char of text) {
    if (char in CHINESE_DIGITS) {
      current = CHINESE_DIGITS[char];
      seenAny = true;
    } else if (char === '十') {
      total += (current || 1) * 10;
      current = 0;
      seenAny = true;
    } else if (char === '百') {
      total += (current || 1) * 100;
      current = 0;
      seenAny = true;
    } else {
      return null;
    }
  }
  return seenAny ? total + current : null;
}

function cleanValue(value: string): string {
  return value
    .replace(/^[\s:,，、.。]+/, '')
    .replace(/[\s:,，、.。(（]+$/, '')
    .trim();
}

/** 值在下一个字段名、分隔符处截断 */
function cutAtNextField(value: string): string {
  let end = value.length;
  const separator = SEPARATOR_RE.exec(value);
  if (separator) end = Math.min(end, separator.index);
  const field = FIELD_CUT_RE.exec(value);
  // 开头就是字段名的不截（那是值本身被认成了字段名的样子，很少见），从第 1 个字以后找
  if (field && field.index > 0) end = Math.min(end, field.index);
  return cleanValue(value.slice(0, end));
}

function lineScore(line: LabelLine): number {
  return typeof line.score === 'number' && Number.isFinite(line.score) ? line.score : 1;
}

type Rect = { left: number; top: number; right: number; bottom: number; height: number };

function rectOf(line: LabelLine): Rect | null {
  const box = line.box;
  if (!box || box.length < 4) return null;
  const xs = box.map((point) => point[0]);
  const ys = box.map((point) => point[1]);
  if (![...xs, ...ys].every(Number.isFinite)) return null;
  // 字高取左右两条竖边的平均长度（斜着的行也对）
  const leftEdge = Math.hypot(box[3][0] - box[0][0], box[3][1] - box[0][1]);
  const rightEdge = Math.hypot(box[2][0] - box[1][0], box[2][1] - box[1][1]);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
    height: (leftEdge + rightEdge) / 2,
  };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// ───────────────────────────── 各字段 ─────────────────────────────

function findName(texts: string[]): string | null {
  for (let index = 0; index < texts.length; index++) {
    const match = NAME_KEY_RE.exec(texts[index]);
    if (!match) continue;
    let value = cutAtNextField(texts[index].slice(match.index + match[0].length));
    // 「产品名称：」后面空着，名称在下一行
    if (!value && index + 1 < texts.length && !FIELD_CUT_RE.test(texts[index + 1])) {
      value = cutAtNextField(texts[index + 1]);
    }
    if (value.length >= 2 && value.length <= 30) return value;
  }
  return null;
}

function formatSpec(match: RegExpExecArray): string {
  const [, amount, rawUnit, count, countUnit] = match;
  const lower = rawUnit.toLowerCase();
  const unit = lower === 'ml' ? 'mL' : lower === 'l' ? 'L' : /^[a-z]+$/.test(lower) ? lower : rawUnit;
  return `${amount}${unit}${count ? `×${count}${countUnit ?? ''}` : ''}`;
}

function findSpec(texts: string[]): string | null {
  for (const text of texts) {
    SPEC_KEY_RE.lastIndex = 0;
    let key: RegExpExecArray | null;
    while ((key = SPEC_KEY_RE.exec(text))) {
      const value = SPEC_VALUE_RE.exec(text.slice(key.index + key[0].length));
      if (value) return formatSpec(value);
    }
  }
  return null;
}

const SHELF_LIMITS: Record<ShelfLifeUnit, number> = { day: 3650, month: 120, year: 10 };

function toShelfLife(amountText: string, unitText: string): ShelfLife | null {
  const amount = parseChineseNumber(amountText);
  const compact = unitText.replace(/\s/g, '').toLowerCase();
  const unit: ShelfLifeUnit | null =
    compact === '个月' || compact === '月' || compact.startsWith('month')
      ? 'month'
      : compact === '年' || compact.startsWith('year')
        ? 'year'
        : compact === '天' || compact === '日' || compact.startsWith('day')
          ? 'day'
          : null;
  if (amount === null || !unit || amount <= 0 || amount > SHELF_LIMITS[unit]) return null;
  return { amount, unit };
}

function findShelfLife(texts: string[]): ShelfLife | null {
  for (const text of texts) {
    const match = SHELF_RE.exec(text) ?? SHELF_EN_RE.exec(text);
    if (!match) continue;
    const shelfLife = toShelfLife(match[1], match[2]);
    if (shelfLife) return shelfLife;
  }
  return null;
}

function findDateElsewhere(texts: string[]): string | null {
  for (const text of texts) {
    const match = ELSEWHERE_RE.exec(text);
    if (!match) continue;
    const value = cutAtNextField(match[1]);
    if (value.length >= 2 && ELSEWHERE_PLACE_RE.test(value)) return value;
  }
  return null;
}

type Keyword = { role: DateRole; index: number; end: number };

function keywordsIn(text: string): Keyword[] {
  const found: Keyword[] = [];
  const collect = (re: RegExp, role: DateRole) => {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      found.push({ role, index: match.index, end: match.index + match[0].length });
      if (match[0].length === 0) re.lastIndex++;
    }
  };
  collect(EXPIRY_KEY_RE, 'expiry');
  collect(PRODUCTION_KEY_RE, 'production');
  // 「保质期至」里的「保质」不是生产；同一处既像到期又像生产时按到期算（到期的关键词更具体）
  return found
    .filter((keyword) =>
      keyword.role === 'expiry' ||
      !found.some((other) => other.role === 'expiry' && other.index <= keyword.index && other.end >= keyword.end),
    )
    .sort((a, b) => a.index - b.index);
}

/** index 是日期在行里从哪开始，end 是日期到哪结束（20261012 后面紧跟的时间、班次数字不算在里面） */
type FoundDate = { date: string; index: number; end: number };

function toDateStr(year: string, month: string, day: string): string | null {
  const value = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  return isValidDateStr(value) ? value : null;
}

/** 一行里所有写法对的日期（不管合不合理），按在行里的位置排 */
export function datesInText(text: string): FoundDate[] {
  const found: FoundDate[] = [];
  const taken: [number, number][] = [];
  DATE_SEP_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DATE_SEP_RE.exec(text))) {
    const start = match.index + match[1].length;
    const date = toDateStr(match[2], match[3], match[4]);
    if (date) {
      const end = match.index + match[0].length;
      found.push({ date, index: start, end });
      taken.push([start, end]);
    }
  }
  DATE_COMPACT_RE.lastIndex = 0;
  while ((match = DATE_COMPACT_RE.exec(text))) {
    const start = match.index + match[1].length;
    if (taken.some(([from, to]) => start >= from && start < to)) continue;
    const date = toDateStr(match[2], match[3], match[4]);
    if (date) found.push({ date, index: start, end: start + 8 });
    // 「(^|\D)」吃掉了前一个字符，下一轮从数字串后面接着找
    DATE_COMPACT_RE.lastIndex = match.index + match[0].length;
  }
  return found.sort((a, b) => a.index - b.index);
}

/** 不在同一行时，按位置找离日期最近的「只写了字段名、没有日期」的那一行，看它是生产还是到期 */
function roleFromNeighbours(lineIndex: number, texts: string[], rects: (Rect | null)[], labelOnly: (DateRole | null)[]): DateRole | null {
  const own = rects[lineIndex];
  if (!own) {
    // 没有位置信息：看紧挨着的上一行
    return lineIndex > 0 ? labelOnly[lineIndex - 1] : null;
  }
  let best: { role: DateRole; distance: number } | null = null;
  for (let index = 0; index < texts.length; index++) {
    const role = labelOnly[index];
    const rect = rects[index];
    if (index === lineIndex || !role || !rect) continue;
    const size = Math.max(own.height, rect.height, 1);
    const ownMiddle = (own.top + own.bottom) / 2;
    const middle = (rect.top + rect.bottom) / 2;
    let distance: number | null = null;
    // 同一排、在日期左边
    if (Math.abs(ownMiddle - middle) <= size * 0.6 && rect.right <= own.left + size) {
      distance = Math.max(0, own.left - rect.right);
    } else if (rect.bottom <= own.top + size * 0.5 && rect.right > own.left - size && rect.left < own.right + size) {
      // 正上方（左右有重叠），隔不超过两行
      const gap = Math.max(0, own.top - rect.bottom);
      if (gap <= size * 2) distance = gap + size; // 上面的比同一排左边的远一点
    }
    if (distance !== null && (!best || distance < best.distance)) best = { role, distance };
  }
  return best?.role ?? null;
}

/** 同一行里这个日期后面（到下一个日期为止）紧跟着时间 */
function followedByTime(text: string, item: FoundDate, found: FoundDate[]): boolean {
  const next = found.find((other) => other.index >= item.end);
  return TIME_AFTER_DATE_RE.test(text.slice(item.end, next ? next.index : text.length));
}

function findDates(texts: string[], rects: (Rect | null)[], today: string): LabelDate[] {
  const earliest = addYears(today, -5);
  const latest = addYears(today, 10);
  const perLine = texts.map((text) => datesInText(text));
  // 只有字段名（生产日期：/ 保质期至）没有日期的行
  const labelOnly = texts.map((text, index) => {
    if (perLine[index].length) return null;
    const keywords = keywordsIn(text);
    return keywords.length ? keywords[keywords.length - 1].role : null;
  });
  const result: LabelDate[] = [];
  perLine.forEach((found, lineIndex) => {
    const keywords = keywordsIn(texts[lineIndex]);
    for (const item of found) {
      if (item.date < earliest || item.date > latest) continue;
      // 同一行里日期前面最近的字段名
      const before = keywords.filter((keyword) => keyword.end <= item.index);
      let role: DateRole | null = before.length ? before[before.length - 1].role : null;
      if (!role && !keywords.length) role = roleFromNeighbours(lineIndex, texts, rects, labelOnly);
      // 旁边没写字、后面跟着时间的：当生产日期
      let byTime = false;
      if (!role && followedByTime(texts[lineIndex], item, found)) {
        role = 'production';
        byTime = true;
      }
      // 生产日期不晚于今天、不早于 5 年前；不合理的不按生产日期算，交给人看
      if (role === 'production' && item.date > today) {
        role = null;
        byTime = false;
      }
      const existing = result.find((other) => other.date === item.date);
      if (existing) {
        if (!existing.role && role) {
          existing.role = role;
          existing.byTime = byTime;
        }
        continue;
      }
      result.push({ date: item.date, role, line: lineIndex, byTime });
    }
  });
  return result;
}

function assessQuality(lines: LabelLine[]): LabelQuality {
  const usable = lines.filter((line) => lineScore(line) >= 0.5 && normalizeText(line.text).replace(/\s/g, '').length >= 2);
  const meanScore = usable.length ? usable.reduce((sum, line) => sum + lineScore(line), 0) / usable.length : 0;
  return {
    usableLines: usable.length,
    meanScore: Math.round(meanScore * 1000) / 1000,
    poor: usable.length === 0 || meanScore < 0.7,
  };
}

/** 字明显比别的大的几行：名称拿不准时给人点选 */
function findNameCandidates(lines: LabelLine[], texts: string[], rects: (Rect | null)[], chosen: string | null): string[] {
  const heights = rects.filter((rect): rect is Rect => rect !== null).map((rect) => rect.height);
  if (heights.length < 2) return [];
  const typical = median(heights);
  const candidates = lines
    .map((line, index) => ({ text: cleanValue(texts[index]), rect: rects[index], score: lineScore(line) }))
    .filter(
      ({ text, rect, score }) =>
        rect !== null &&
        rect.height >= typical * 1.25 &&
        score >= 0.8 &&
        text.length >= 2 &&
        text.length <= 20 &&
        // 主要是汉字或字母（不是一串数字、符号），也不是「xx：xx」这样的字段
        (text.match(/[一-龥A-Za-z]/g)?.length ?? 0) >= Math.ceil(text.length / 2) &&
        !text.includes(':') &&
        text !== chosen,
    )
    .sort((a, b) => (b.rect?.height ?? 0) - (a.rect?.height ?? 0));
  const result: string[] = [];
  for (const candidate of candidates) {
    if (!result.includes(candidate.text)) result.push(candidate.text);
    if (result.length >= 3) break;
  }
  return result;
}

/**
 * 从认出的文字行里找字段。today 是 YYYY-MM-DD（判断日期合不合理用），测试时传固定值。
 * 认不准的都是 null，不猜。
 */
export function parseLabel(lines: LabelLine[], today: string): LabelParseResult {
  const texts = lines.map((line) => normalizeText(line.text));
  const rects = lines.map(rectOf);
  const name = findName(texts);
  return {
    name,
    nameCandidates: findNameCandidates(lines, texts, rects, name),
    spec: findSpec(texts),
    shelfLife: findShelfLife(texts),
    dateElsewhere: findDateElsewhere(texts),
    dates: findDates(texts, rects, today),
    quality: assessQuality(lines),
  };
}

// ───────────────────────────── 日期怎么填 ─────────────────────────────

export type DateOption = {
  date: string;
  /** 看旁边的字或日期先后猜的用途；分不清是 null */
  role: DateRole | null;
  /** 给人看的一句说明，例如「写着「生产」」「排在前面，像是生产日期」 */
  note: string;
};

export type DateDecision = {
  /** 能直接填的生产日期 / 到期日；分不清、对不上时是 null，看 options */
  production: string | null;
  expiry: string | null;
  /** 生产日期 + 保质期 和印着的到期日对上了（互相印证） */
  confirmed: boolean;
  /** 到期日旁边没写字，是按先后填的（前面的当生产日期、后面的当到期日）：界面提示「按先后填的，请核对」 */
  byOrder: boolean;
  /** 要人选的时候列出来的日期（按先后）；能直接填时是空的 */
  options: DateOption[];
  /** options 里建议先选哪个（下标），没有建议是 -1 */
  suggested: number;
};

/** 生产日期加保质期是不是正好到这个到期日（各家算法差一天：有的算到前一天，有的算到同一天） */
export function matchesShelfLife(production: string, expiry: string, shelfLife: ShelfLife): boolean {
  const computed = expiryFromShelfLife(production, shelfLife.amount, shelfLife.unit);
  return Math.abs(diffDays(expiry, computed)) <= 1;
}

function describeGap(days: number): string {
  if (days >= 330 && days <= 400) return '差不多一年';
  if (days >= 700 && days <= 760) return '差不多两年';
  if (days >= 28 && days < 330) return `差不多 ${Math.round(days / 30)} 个月`;
  return `${days} 天`;
}

/** 按先后填时，到期日最少比生产日期晚几天、最多晚几年 */
const ORDER_MIN_DAYS = 7;
const ORDER_MAX_YEARS = 5;

/** 两个旁边没写字（或只有生产日期写了字）的日期能不能按先后当生产日期、到期日：前一个不晚于今天，后一个在今天以后、晚 7 天到 5 年 */
function fitsByOrder(production: string, expiry: string, today: string): boolean {
  return (
    production <= today &&
    expiry > today &&
    diffDays(expiry, production) >= ORDER_MIN_DAYS &&
    expiry <= addYears(production, ORDER_MAX_YEARS)
  );
}

/**
 * 认出的日期怎么填：能分清的直接给生产日期 / 到期日，分不清的列出来让人选（规则见文件头）。
 * - dates：parseLabel 认出的日期，按在标签上出现的先后
 * - shelfLife：商品资料里或标签上认出的保质期，用来互相印证；没有就是 null
 * - target：用户点的是哪一格旁边的「拍日期」。只认出一个分不清用途的日期时填进这一格（在今天以后的一定是到期日）
 */
export function decideDates(
  dates: LabelDate[],
  { shelfLife, today, target }: { shelfLife: ShelfLife | null; today: string; target: DateRole },
): DateDecision {
  const sorted = [...dates].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const none: DateDecision = { production: null, expiry: null, confirmed: false, byOrder: false, options: [], suggested: -1 };
  if (!sorted.length) return none;

  const productions = sorted.filter((item) => item.role === 'production');
  const expiries = sorted.filter((item) => item.role === 'expiry');
  const unknown = sorted.filter((item) => item.role === null);
  const agree = (production: string, expiry: string) => !!shelfLife && matchesShelfLife(production, expiry, shelfLife);

  const choose = (): DateDecision => {
    const options = sorted.map((item, index): DateOption => {
      let note = '';
      if (item.role === 'production') note = item.byTime ? '后面跟着时间，像是生产日期' : '旁边写着「生产」';
      else if (item.role === 'expiry') note = '旁边写着「保质期至 / 有效期至 / EXP」';
      else if (index > 0) note = `比前一个晚${describeGap(diffDays(item.date, sorted[index - 1].date))}，像是保质期至`;
      else if (item.date > today) note = '在今天以后，像是到期日';
      else if (sorted.length > 1) note = '排在前面，像是生产日期';
      return { date: item.date, role: item.role, note };
    });
    // 建议：要生产日期时选最早的一个不在今天以后的；要到期日时选最晚的
    let suggested = -1;
    if (target === 'production') {
      suggested = options.findIndex((option) => option.role === 'production');
      if (suggested < 0) suggested = options.findIndex((option) => option.role !== 'expiry' && option.date <= today);
    } else {
      for (let index = options.length - 1; index >= 0 && suggested < 0; index--) {
        if (options[index].role !== 'production') suggested = index;
      }
    }
    return { ...none, options, suggested };
  };

  // 写了字、能分清的
  if (productions.length <= 1 && expiries.length <= 1 && (productions.length || expiries.length)) {
    const production = productions[0]?.date ?? null;
    const expiry = expiries[0]?.date ?? null;
    if (production && expiry) {
      if (expiry <= production) return choose();
      // 有保质期却对不上：列出来让人选，不猜
      if (shelfLife && !agree(production, expiry)) return choose();
      return { ...none, production, expiry, confirmed: agree(production, expiry) };
    }
    if (production) {
      // 另外还有一个没写字、正好差一个保质期的：当到期日
      const later = unknown.find((item) => item.date > production && agree(production, item.date));
      if (later) return { ...none, production, expiry: later.date, confirmed: true };
      // 不知道保质期，另外只有一个没写字的日期、按先后像到期日：当到期日
      if (!shelfLife && unknown.length === 1 && fitsByOrder(production, unknown[0].date, today)) {
        return { ...none, production, expiry: unknown[0].date, byOrder: true };
      }
      // 生产日期只是看后面跟着时间认的，又分不出另外的日期：和都没写字时一样列出来让人选
      if (productions[0].byTime && unknown.length) return choose();
      return { ...none, production };
    }
    if (expiry) {
      const earlier = unknown.find((item) => item.date < expiry && item.date <= today && agree(item.date, expiry));
      return { ...none, production: earlier?.date ?? null, expiry, confirmed: !!earlier };
    }
  }
  if (productions.length || expiries.length) return choose();

  // 都没写字
  if (unknown.length === 1) {
    const only = unknown[0].date;
    if (only > today || target === 'expiry') return { ...none, expiry: only };
    return { ...none, production: only };
  }
  if (unknown.length === 2 && agree(unknown[0].date, unknown[1].date) && unknown[0].date <= today) {
    return { ...none, production: unknown[0].date, expiry: unknown[1].date, confirmed: true };
  }
  // 不知道保质期：按在标签上的先后，前面的当生产日期、后面的当到期日（前面的反而晚就不填）
  if (unknown.length === 2 && !shelfLife) {
    const [first, second] = dates;
    if (first.date < second.date && fitsByOrder(first.date, second.date, today)) {
      return { ...none, production: first.date, expiry: second.date, byOrder: true };
    }
  }
  return choose();
}

/** 一次识别认出了几项（名称、规格、保质期、日期各算一项），界面「已从照片填入 N 项」用 */
export function countRecognized(result: LabelParseResult, decision: DateDecision): number {
  return (
    (result.name ? 1 : 0) +
    (result.spec ? 1 : 0) +
    (result.shelfLife ? 1 : 0) +
    (decision.production || decision.expiry ? 1 : 0)
  );
}
