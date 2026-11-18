import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { safeFileName } from './csv';

/** 把 CSV 文本存成文件，用系统分享发出去（存到「文件」、发微信、发邮件……）。 */
export async function shareCsv(fileName: string, csvText: string, dialogTitle = '保存或发送表格'): Promise<void> {
  const name = safeFileName(fileName.replace(/\.csv$/i, '')) || 'export';
  const file = new File(Paths.cache, `${name}.csv`);
  file.create({ overwrite: true });
  await file.write(csvText);
  if (!(await Sharing.isAvailableAsync())) throw new Error('这台手机不支持系统分享，没法把表格存出去');
  await Sharing.shareAsync(file.uri, {
    mimeType: 'text/csv',
    UTI: 'public.comma-separated-values-text',
    dialogTitle,
  });
}
