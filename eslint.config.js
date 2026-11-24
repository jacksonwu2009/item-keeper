// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    // 文字一律用 src/components/Text：安卓上指定了字体，红米切换深色 / 浅色后文字不会显示不全（原因见那个文件）
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/components/Text.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react-native',
              importNames: ['Text'],
              message: '用 src/components/Text（安卓上指定了字体，原因见那个文件）。',
            },
            {
              // 从总入口引会把 19 套图标字体全打进安装包（约 2 MB），只用 Ionicons 就单独引它
              name: '@expo/vector-icons',
              message: "用 import Ionicons from '@expo/vector-icons/Ionicons'（只打包这一套字体）。",
            },
          ],
        },
      ],
    },
  },
]);
