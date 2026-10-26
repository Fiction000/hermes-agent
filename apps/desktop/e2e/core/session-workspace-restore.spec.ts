/** Saved Workspace restore gate. Synthetic DB/provider, private app/userData only. */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { type ElectronApplication, expect, test } from '@playwright/test'

import { coreAppEnv, createCoreSandbox, launchCoreApp, sandboxProcesses, waitForInteractive, writeProviderHome } from './harness'
import { startScriptedProvider } from './provider'

process.env.HERMES_E2E_CORE_ROOT ??= path.join(os.homedir(), '.hermes', 'cache', 'scratch', 'workspace-restore')

for (const recoverLegacy of [false, true]) {
test(`saved four-pane selection survives restart, settings revisit and plugin rebind with composers (legacy recovery: ${recoverLegacy})`, async () => {
  test.setTimeout(240_000)
  const provider = await startScriptedProvider()
  const sandbox = createCoreSandbox('workspace-restore')
  writeProviderHome(sandbox.hermesHome, provider.url)
  const ids = Array.from({ length: 4 }, (_, i) => `workspace-restore-${i + 1}`)

  // Same persisted shape as the closed production snapshot: four valid owner
  // keys, while the ordinary tile bucket contains unrelated, ownerless tabs.
  const selected = ids.map((storedSessionId, i) => ({ storedSessionId, ownerRoute: {
    connectionId: 'local', profile: 'default', ...(i ? { targetProfile: 'default' } : {})
  } }))

  const script = [
    'import sys', 'from pathlib import Path', 'from hermes_state import SessionDB',
    "db = SessionDB(db_path=Path(sys.argv[1]) / 'state.db')",
    'for sid in sys.argv[2:]:', "    db.create_session(sid, source='cli', model='mock-model')",
    "    db.append_message(sid, role='user', content=f'Synthetic question {sid}')",
    "    db.append_message(sid, role='assistant', content=f'Synthetic saved answer {sid}')", 'db.close()'
  ].join('\n')

  execFileSync(process.env.HERMES_E2E_PYTHON ?? 'python3', ['-c', script, sandbox.hermesHome, ...ids], {
    cwd: path.resolve(process.cwd(), '../..'), env: { ...process.env, HERMES_HOME: sandbox.hermesHome }
  })
  let app: ElectronApplication | undefined

  try {
    let launched = await launchCoreApp(coreAppEnv(sandbox))
    app = launched.app
    await waitForInteractive(app, launched.page)
    await launched.page.evaluate(({ selected, recoverLegacy }) => {
      localStorage.setItem('hermes.desktop.pluginDecisions.v2', JSON.stringify({ 'session-workspace': true }))
      localStorage.setItem('hermes.plugin.session-workspace.selection.v1', JSON.stringify(selected))
      localStorage.setItem('hermes.plugin.session-workspace.layout.v1', JSON.stringify('grid'))
      localStorage.setItem('hermes.plugin.session-workspace.focus.v1', JSON.stringify(selected[0]))

      if (recoverLegacy) {
        localStorage.setItem('hermes.plugin.session-workspace.arrangement.last.v2', JSON.stringify('arrangement.v2.[]'))
        localStorage.setItem('hermes.plugin.session-workspace.arrangement.v2.[]', JSON.stringify({ selection: [], layout: 'grid', focused: null }))
      }

      localStorage.setItem('hermes.desktop.sessionTiles.v2', JSON.stringify({ default: [
        { storedSessionId: 'unrelated-saved-tab', anchor: 'workspace', dir: 'center', workspaceMode: 'sessions' }
      ] }))
    }, { selected, recoverLegacy })
    await app.close()
    app = undefined

    launched = await launchCoreApp(coreAppEnv(sandbox))
    app = launched.app
    const { page } = launched
    await waitForInteractive(app, page)
    await page.setViewportSize({ width: 1600, height: 1000 })
    await page.evaluate(() => { location.hash = '#/session-workspace' })

    if (recoverLegacy) {
      await expect(page.getByText('0 / 4 sessions', { exact: true })).toBeVisible()
      const restore = page.getByRole('button', { name: 'Restore saved v1 selection', exact: true })
      await expect(restore).toBeVisible()
      await page.screenshot({ path: path.join(sandbox.root, 'legacy-recovery-before.png') })
      await page.reload()
      await expect(page.getByText('0 / 4 sessions', { exact: true })).toBeVisible()
      await restore.click()
      await expect(restore).toHaveCount(0)
    }

    await expect(page.getByText('4 / 4 sessions', { exact: true })).toBeVisible()
    await page.screenshot({ path: path.join(sandbox.root, 'restored-before-check.png') })
    const diagnostics = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => /session-workspace|sessionTiles/.test(key))))
    fs.writeFileSync(path.join(sandbox.root, 'restore-storage.json'), JSON.stringify(diagnostics, null, 2))
    console.log(`restore sandbox: ${sandbox.root}`)
    // Do route and plugin lifecycle checks even when tiles cannot restore, so a
    // second loss of selection is distinguished from missing tile bindings.
    await page.evaluate(() => { location.hash = '#/settings' })
    await expect(page.locator('[data-overlay-surface]')).toBeVisible()
    await expect(page).toHaveURL(/#\/settings/)
    await page.evaluate(() => { location.hash = '#/session-workspace' })
    await expect(page.getByText('4 / 4 sessions', { exact: true })).toBeVisible()

    const rebindWorkspace = async () => {
      await page.evaluate(() => { location.hash = '#/capabilities?tab=plugins' })
      await page.locator('[data-catalog-filters]').getByRole('button', { name: /Filters/ }).click()
      await page.locator('[data-catalog-expanded-filters]').getByRole('button', { name: 'Installed' }).click()
      const toggle = page.getByRole('switch', { name: 'Session Workspace' })
      await expect(toggle).toHaveAttribute('aria-checked', 'true')
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-checked', 'true')
      await page.evaluate(() => { location.hash = '#/session-workspace' })
      await expect(page.getByText('4 / 4 sessions', { exact: true })).toBeVisible()
    }

    await rebindWorkspace()
    await expect(page.locator('[data-workspace-session]')).toHaveCount(4, { timeout: 10_000 })

    for (const id of ids) {
      const tile = page.locator(`[data-workspace-session="${id}"]`)
      await expect(tile).toContainText(`Synthetic saved answer ${id}`)
      await expect(tile.locator('[data-slot="composer-root"] [contenteditable="true"]').first()).toBeVisible()
    }

    const draft = page.locator(`[data-workspace-session="${ids[0]}"] [contenteditable="true"]`).first()
    await draft.fill('復元後の隔離下書き')
    await page.evaluate(() => { location.hash = '#/settings' })
    await expect(page.locator('[data-overlay-surface]')).toBeVisible()
    await expect(page).toHaveURL(/#\/settings/)
    await page.evaluate(() => { location.hash = '#/session-workspace' })
    await expect(draft).toHaveText('復元後の隔離下書き')
    await rebindWorkspace()
    await expect(draft).toHaveText('復元後の隔離下書き')
    await expect(page.locator('[data-workspace-session]')).toHaveCount(4)
    expect(provider.completions).toHaveLength(0)
    await page.screenshot({ path: path.join(sandbox.root, 'restored-after-rebind.png') })

    if (recoverLegacy) {
      await app.close()
      app = undefined
      const restarted = await launchCoreApp(coreAppEnv(sandbox))
      app = restarted.app
      await waitForInteractive(app, restarted.page)
      await restarted.page.evaluate(() => { location.hash = '#/session-workspace' })
      await expect(restarted.page.getByText('4 / 4 sessions', { exact: true })).toBeVisible()
      await expect(restarted.page.locator('[data-workspace-session]')).toHaveCount(4)

      for (let i = 0; i < 4; i++) {
        await restarted.page.getByRole('button', { name: /^Remove .* from workspace$/ }).first().click()
      }

      await expect(restarted.page.getByText('0 / 4 sessions', { exact: true })).toBeVisible()
      await restarted.page.reload()
      await expect(restarted.page.getByText('0 / 4 sessions', { exact: true })).toBeVisible()
      await expect(restarted.page.getByRole('button', { name: 'Restore saved v1 selection', exact: true })).toBeVisible()
      expect(provider.completions).toHaveLength(0)
    }

    console.log('RESTORE_GATE: selection=4/4 after restart/settings/rebind; composers=4; provider_calls=0')
  } finally {
    await app?.close().catch(() => {})
    await provider.close()
    sandbox.cleanup()
  }

  await expect.poll(() => sandboxProcesses(sandbox).length, { timeout: 30_000 }).toBe(0)
})
}
