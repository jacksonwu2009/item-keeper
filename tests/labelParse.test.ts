import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  datesInText,
  decideDates,
  matchesShelfLife,
  normalizeText,
  parseChineseNumber,
  parseLabel,
  type DateRole,
  type LabelLine,
  type ShelfLife,
} from '../src/lib/labelParse';

/**
 * 测试数据在 tests/fixtures/label-ocr/*.json（格式见那里的 README.md），鸿蒙版的 LabelParse.ets 跑同一批。
 * expect 里写了的键才比：
 * - name / spec / shelfLife / dateElsewhere / nameCandidates：parseLabel 的结果
 * - production / expiry / confirmed：decideDates 的结果；options 是要人选的个数，suggested 是建议选第几个
 * - dates：认出的日期（按出现顺序）；poor：是不是提示重拍
 */
type FixtureItem = {
  id: string;
  description?: string;
  today?: string;
  target?: DateRole;
  shelfLife?: ShelfLife;
  lines: LabelLine[];
  expect: Record<string, unknown>;
};
type Fixture = { format: string; engine: string; today: string; items: FixtureItem[] };

const FIXTURE_DIR = join(__dirname, 'fixtures', 'label-ocr');
const fixtures = readdirSync(FIXTURE_DIR)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => ({ file, data: JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')) as Fixture }));

function runItem(fixture: Fixture, item: FixtureItem) {
  const today = item.today ?? fixture.today;
  const result = parseLabel(item.lines, today);
  const decision = decideDates(result.dates, {
    shelfLife: item.shelfLife ?? result.shelfLife,
    today,
    target: item.target ?? 'production',
  });
  const actual: Record<string, unknown> = {
    name: result.name,
    nameCandidates: result.nameCandidates,
    spec: result.spec,
    shelfLife: result.shelfLife,
    dateElsewhere: result.dateElsewhere,
    dates: result.dates.map((item) => item.date),
    poor: result.quality.poor,
    production: decision.production,
    expiry: decision.expiry,
    confirmed: decision.confirmed,
    options: decision.options.length,
    suggested: decision.suggested,
  };
  return { result, decision, actual };
}

describe('拍照识别：按测试数据提取字段', () => {
  assert.ok(fixtures.length >= 5, '测试数据文件不全');
  for (const { file, data } of fixtures) {
    describe(file, () => {
      assert.equal(data.format, 'label-ocr-fixture/1');
      for (const item of data.items) {
        it(`${item.id}${item.description ? `：${item.description}` : ''}`, () => {
          const { actual } = runItem(data, item);
          const picked = Object.fromEntries(Object.keys(item.expect).map((key) => [key, actual[key]]));
          assert.deepEqual(picked, item.expect);
        });
      }
    });
  }
});

describe('拍照识别：第一轮照片的字段数（和方案第九节对照）', () => {
  /** 照片上肉眼能看到的字段：1 名称、保质期、生产日期（见包装）；2 规格；3 名称、保质期、生产日期（见喷码）；4 名称、生产日期 */
  const VISIBLE = 9;
  function score(file: string): number {
    const fixture = fixtures.find((candidate) => candidate.file === file)?.data;
    assert.ok(fixture, file);
    let count = 0;
    for (const item of fixture.items) {
      const { result, decision } = runItem(fixture, item);
      count += (result.name ? 1 : 0) + (result.spec ? 1 : 0) + (result.shelfLife ? 1 : 0);
      count += result.dateElsewhere || decision.production ? 1 : 0;
    }
    return count;
  }

  it('PP-OCRv6_small 6/9，比 tiny、v5_mobile 好；苹果系统识别只认出一个日期时也填上以后 5/9', () => {
    assert.equal(score('round1-desktop-PP-OCRv6_small.json'), 6);
    assert.equal(score('round1-desktop-PP-OCRv6_tiny.json'), 5);
    assert.equal(score('round1-desktop-PP-OCRv5_mobile.json'), 3);
    assert.equal(score('round1-desktop-apple-vision.json'), 5);
    assert.ok(score('round1-desktop-PP-OCRv6_small.json') <= VISIBLE);
  });
});

describe('拍照识别：小工具', () => {
  it('中文数字', () => {
    assert.equal(parseChineseNumber('三'), 3);
    assert.equal(parseChineseNumber('十'), 10);
    assert.equal(parseChineseNumber('十二'), 12);
    assert.equal(parseChineseNumber('二十四'), 24);
    assert.equal(parseChineseNumber('一百八十'), 180);
    assert.equal(parseChineseNumber('两'), 2);
    assert.equal(parseChineseNumber('18'), 18);
    assert.equal(parseChineseNumber('三层'), null);
  });

  it('全角转半角、冒号统一', () => {
    assert.equal(normalizeText('ＥＸＰ：２０２７．１０．１１'), 'EXP:2027.10.11');
  });

  it('一行里的几种日期写法', () => {
    assert.deepEqual(
      datesInText('2026.10.12/2027-1-5 20280203 2029年3月4日').map((item) => item.date),
      ['2026-10-12', '2027-01-05', '2028-02-03', '2029-03-04'],
    );
    assert.deepEqual(datesInText('2026.13.01 20260231').map((item) => item.date), []);
  });

  it('生产日期 + 保质期 和到期日差一天也算对上（有的算到前一天，有的算到同一天）', () => {
    const year = { amount: 1, unit: 'year' as const };
    assert.ok(matchesShelfLife('2026-10-12', '2027-10-11', year));
    assert.ok(matchesShelfLife('2026-10-12', '2027-10-12', year));
    assert.ok(!matchesShelfLife('2026-10-12', '2027-10-20', year));
    assert.ok(matchesShelfLife('2026-11-01', '2026-11-30', { amount: 30, unit: 'day' }));
  });
});
