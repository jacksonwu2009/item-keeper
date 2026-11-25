import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// 列表闪动的修法是给 @react-native/virtualized-lists 打补丁（patches/ 目录，npm install 后由 postinstall 打上）。
// 补丁没打上、或者升级了 React Native 而补丁还停在旧版本，都要在这里报出来。
const root = join(__dirname, '..');
const listsDir = join(root, 'node_modules', '@react-native', 'virtualized-lists');

describe('列表闪动补丁', () => {
  it('补丁文件对应的版本就是装着的版本', () => {
    const installed = JSON.parse(readFileSync(join(listsDir, 'package.json'), 'utf8')).version as string;
    const patchFiles = readdirSync(join(root, 'patches')).filter((name) => name.startsWith('@react-native+virtualized-lists+'));
    assert.deepEqual(patchFiles, [`@react-native+virtualized-lists+${installed}.patch`]);
  });

  it('估算没量过的行的位置时加上列表头的长度', () => {
    const aggregator = readFileSync(join(listsDir, 'Lists', 'ListMetricsAggregator.js'), 'utf8');
    assert.match(aggregator, /offset = this\._getLeadingLength\(props\) \+ this\._averageCellLength \* index;/);
    assert.match(aggregator, /notifyListHeaderLayout\(/);

    const list = readFileSync(join(listsDir, 'Lists', 'VirtualizedList.js'), 'utf8');
    assert.match(list, /this\._listMetrics\.notifyListHeaderLayout\(\{/);
  });
});
