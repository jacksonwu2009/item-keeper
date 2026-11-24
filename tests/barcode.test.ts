import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  barcodeFieldError,
  isProductBarcode,
  normalizeBarcodeInput,
  NOT_PRODUCT_BARCODE,
  OLD_BARCODE_ERROR,
  PRODUCT_BARCODE_ERROR,
  productBarcodeError,
} from '../src/lib/barcode';

describe('商品条码：8–14 位数字', () => {
  it('常见的几种商品条码都算', () => {
    assert.equal(isProductBarcode('96385074'), true, 'EAN-8');
    assert.equal(isProductBarcode('01234565'), true, 'UPC-E 印出来 8 位');
    assert.equal(isProductBarcode('036000291452'), true, 'UPC-A 12 位');
    assert.equal(isProductBarcode('6901234567892'), true, 'EAN-13 国内 69 开头');
    assert.equal(isProductBarcode('2000123012345'), true, '超市称重码 2 开头');
    assert.equal(isProductBarcode('16901234567899'), true, 'ITF-14 整箱码');
  });

  it('不查校验位：店内码校验位不对也放行', () => {
    assert.equal(isProductBarcode('6901234567890'), true);
  });

  it('文字、字母、位数不对、二维码内容都不算', () => {
    assert.equal(isProductBarcode(''), false);
    assert.equal(isProductBarcode('测试'), false);
    assert.equal(isProductBarcode('1234567'), false, '7 位');
    assert.equal(isProductBarcode('123456789012345'), false, '15 位');
    assert.equal(isProductBarcode('690123456789A'), false);
    assert.equal(isProductBarcode('C02XK1ABJGH5'), false, '设备序列号');
    assert.equal(isProductBarcode('https://example.com/p/1'), false, '二维码');
    assert.equal(isProductBarcode('６９０１２３４５６７８９２'), false, '全角数字');
    assert.equal(isProductBarcode('6901234 567892'), false, '中间有空格要先去掉');
  });

  it('手输时去掉空格', () => {
    assert.equal(normalizeBarcodeInput(' 6 901234 567892 '), '6901234567892');
    assert.equal(normalizeBarcodeInput('6901234\t567892'), '6901234567892');
    assert.equal(normalizeBarcodeInput('测 试'), '测试');
  });

  it('条码框的提示：空着可以，填了不合规就提示', () => {
    assert.equal(productBarcodeError(''), null);
    assert.equal(productBarcodeError(null), null);
    assert.equal(productBarcodeError('   '), null);
    assert.equal(productBarcodeError('6901234567892'), null);
    assert.equal(productBarcodeError('6901234 567892'), null);
    assert.equal(productBarcodeError('测试'), PRODUCT_BARCODE_ERROR);
    assert.equal(productBarcodeError('690'), PRODUCT_BARCODE_ERROR);
  });

  it('条码框什么时候提示：还在输数字先不提示，有字母马上提示，老数据一打开就提示', () => {
    assert.equal(barcodeFieldError('690', null, false), null, '还在输');
    assert.equal(barcodeFieldError('690', null, true), PRODUCT_BARCODE_ERROR, '离开输入框或点了保存');
    assert.equal(barcodeFieldError('690A', null, false), PRODUCT_BARCODE_ERROR, '有字母马上提示');
    assert.equal(barcodeFieldError('6901234567892', null, true), null);
    assert.equal(barcodeFieldError('', '测试', true), null, '清空了可以保存');
    assert.equal(barcodeFieldError('测试', '测试', false), OLD_BARCODE_ERROR, '老数据一打开就提示要改');
    assert.equal(barcodeFieldError('6901234 567892', '6901234 567892', false), null, '老数据只是带空格：去掉就合规');
    assert.equal(barcodeFieldError('6901', '测试', false), null, '改着改着还在输数字');
    assert.equal(barcodeFieldError('6901', '测试', true), PRODUCT_BARCODE_ERROR);
  });

  it('提示文字', () => {
    assert.equal(PRODUCT_BARCODE_ERROR, '条码只能是 8–14 位数字');
    assert.equal(NOT_PRODUCT_BARCODE, '这不是商品条码');
  });
});
