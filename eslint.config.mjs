import js from '@eslint/js'
import globals from 'globals'
import {defineConfig} from 'eslint/config'
import prettierPlugin from 'eslint-plugin-prettier'
import prettierConfig from 'eslint-config-prettier'

export default defineConfig([
  {
    files: ['src/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        Odac: 'readonly',
        __dir: 'readonly'
      },
      sourceType: 'script'
    },
    plugins: {
      js,
      prettier: prettierPlugin
    },
    rules: {
      ...js.configs.recommended.rules,
      ...prettierConfig.rules,
      'prettier/prettier': 'error'
    }
  },
  {
    files: ['client/**/*.js'],
    languageOptions: {
      globals: {...globals.browser},
      sourceType: 'module'
    },
    plugins: {js},
    rules: {
      ...js.configs.recommended.rules
    }
  },
  {
    files: ['template/**/*.js'],
    ignores: ['template/public/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        Odac: 'readonly'
      },
      sourceType: 'script'
    },
    plugins: {
      js,
      prettier: prettierPlugin
    },
    rules: {
      ...js.configs.recommended.rules,
      ...prettierConfig.rules,
      'prettier/prettier': 'error'
    }
  },
  {
    files: ['template/public/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        odac: 'readonly'
      },
      sourceType: 'script'
    },
    plugins: {
      js,
      prettier: prettierPlugin
    },
    rules: {
      ...js.configs.recommended.rules,
      ...prettierConfig.rules,
      'prettier/prettier': 'error'
    }
  }
])
