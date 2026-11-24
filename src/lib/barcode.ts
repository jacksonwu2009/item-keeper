/**
 * 食品、日用品的条码（物品条码、包装规格里的整箱条码）只能是 8–14 位数字：
 * EAN-8、UPC-E（印出来 8 位）、UPC-A（12 位）、EAN-13（国内 69 开头、超市称重码 2 开头）、ITF-14 整箱码。
 * 不查校验位，免得误拦店内码。设备序列号不走这条规则（可以有字母）。
 * 手输、扫码、保存都用这里的判断；别的版本照这个规则、这几句话移植。
 */

/** 手输的条码不合规时，框下面的提示 */
export const PRODUCT_BARCODE_ERROR = '条码只能是 8–14 位数字';

/** 食品、日用品扫到的不是商品条码（二维码、带字母的码）时的提示 */
export const NOT_PRODUCT_BARCODE = '这不是商品条码';

const PRODUCT_BARCODE = /^[0-9]{8,14}$/;

/** 是不是商品条码：8–14 位数字（不去空格，调用前先 normalizeBarcodeInput） */
export function isProductBarcode(code: string): boolean {
  return PRODUCT_BARCODE.test(code);
}

/** 手输、粘贴的条码：去掉所有空格（印刷时常常隔开写，如 6 901234 567892） */
export function normalizeBarcodeInput(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * 条码框的错误提示：空着可以（条码不是必填），填了就要是商品条码；没问题返回 null。
 * 先去掉空格再判断，和保存时一样。
 */
export function productBarcodeError(code: string | null | undefined): string | null {
  const value = normalizeBarcodeInput(code ?? '');
  if (!value) return null;
  return isProductBarcode(value) ? null : PRODUCT_BARCODE_ERROR;
}

/** 改资料时，原来存的条码就不合规（改规则以前录的），还没改时的提示 */
export const OLD_BARCODE_ERROR = '条码只能是 8–14 位数字，改成数字或清空才能保存';

/**
 * 条码框下面显示的提示，没有是 null：
 * - 打开时就不合规、还没改的（老数据）：一打开就提示要改；
 * - 有数字以外的字符：马上提示；
 * - 只有数字、位数还不对：还在输的时候先不提示，离开过输入框或点过保存（touched）才提示。
 */
export function barcodeFieldError(value: string, opened: string | null | undefined, touched: boolean): string | null {
  const error = productBarcodeError(value);
  if (!error) return null;
  if (opened && value === opened) return OLD_BARCODE_ERROR;
  return touched || !/^[0-9]*$/.test(normalizeBarcodeInput(value)) ? error : null;
}
