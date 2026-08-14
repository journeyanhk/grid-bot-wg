// ESLint flat config：覆盖 src/ 与 test/（public/ 单文件前端无构建，跳过）
import js from '@eslint/js';

export default [
  { ignores: ['public/', 'node_modules/', 'logs/', 'img/'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        // Node 环境
        console: 'readonly', process: 'readonly', Buffer: 'readonly',
        setTimeout: 'readonly', setInterval: 'readonly', clearTimeout: 'readonly', clearInterval: 'readonly',
        globalThis: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', fetch: 'readonly',
        AbortSignal: 'readonly', BigInt: 'readonly', Promise: 'readonly',
        // 测试文件
        EventEmitter: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-prototype-builtins': 'off',
    },
  },
];
