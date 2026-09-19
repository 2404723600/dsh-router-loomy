/**
 * 独立供应商入口（免改 bundles 的投放路径）。
 *
 * `lib/supplier.js` 的 default 就是供应商工厂，可直接放进
 * `~/.dsh/profiles/web/suppliers/loomy.js`，由 dsh-router 的目录扫描加载；
 * 与宿主半（`lib/index.js` + cordis.patch.yml + dsh.profile.bundles）二选一即可。
 *
 * 两条路径共用同一份 `api/plugin.ts`，不存在实现分叉。
 */
export { default, createSupplier, id, name, priority, icon, apiKeyHint } from './api/plugin.ts'
