import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { partsFromNominatim, suggestOfficeNames } from '../src/lib/placeName';

describe('定位起名', () => {
  it('有楼宇名时排第一，后面是城市+区、区+街道、城市', () => {
    assert.deepEqual(
      suggestOfficeNames({ name: '望京SOHO', street: '阜通东大街', district: '朝阳区', city: '北京市' }),
      ['望京SOHO', '北京朝阳区', '朝阳区阜通东大街', '北京'],
    );
  });

  it('门牌地址不当地点名', () => {
    assert.deepEqual(
      suggestOfficeNames({ name: '阜通东大街6号', street: '阜通东大街', district: '朝阳区', city: '北京市' }),
      ['北京朝阳区', '朝阳区阜通东大街', '北京'],
    );
  });

  it('没有城市时用省；已有的办公点名不再推荐', () => {
    assert.deepEqual(suggestOfficeNames({ district: '南山区', region: '深圳市' }, ['深圳']), ['深圳南山区']);
  });

  it('什么都没有就不推荐', () => {
    assert.deepEqual(suggestOfficeNames({}), []);
  });

  it('OpenStreetMap 结果转换', () => {
    const parts = partsFromNominatim({
      name: '',
      address: { road: '科苑南路', suburb: '粤海街道', city_district: '南山区', city: '深圳市', state: '广东省' },
    });
    assert.deepEqual(parts, {
      name: null,
      street: '科苑南路',
      district: '南山区',
      city: '深圳市',
      region: '广东省',
    });
    assert.deepEqual(suggestOfficeNames(parts ?? {}), ['深圳南山区', '南山区科苑南路', '深圳']);
    assert.equal(partsFromNominatim({ error: 'Unable to geocode' }), null);
  });
});
