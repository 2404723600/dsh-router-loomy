/**
 * tsdown 构建配置 —— 产出两个入口：
 *
 *   lib/index.js    宿主半（host half）：注册 router.suppliers.loomy，供 bundle patch 加载
 *   lib/supplier.js 独立供应商模块：default 导出 factory，可直接投放到
 *                   ~/.dsh/profiles/web/suppliers/loomy.js（免改 bundles 的快捷安装路径）
 *
 * 两个入口共用同一份 api/ 实现；dts 关闭（契约类型靠 src/contract.ts 结构镜像，
 * 插件消费方 dsh-router 核心按结构判定，不需要 .d.ts）。
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    supplier: 'src/supplier.ts',
  },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node20',
  // 产物必须是 .js：package.json 的 main/exports 与 dsh 的 bundle 加载器都按
  // lib/index.js 找入口（与 dsh-router-traework 一致）；tsdown 默认给 ESM 出 .mjs。
  outExtensions: () => ({ js: '.js' }),
  dts: false,
  clean: false,
  sourcemap: false,
})
