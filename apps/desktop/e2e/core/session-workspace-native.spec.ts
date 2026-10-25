/**
 * Native Session Workspace gate: isolated Electron + real Hermes gateway,
 * loopback-only scripted provider, and four disposable conversations.
 * The app is launched with a private HOME/HERMES_HOME/userData directory.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { type ElectronApplication, expect, type Locator, test } from '@playwright/test'

import {
  coreAppEnv,
  createCoreSandbox,
  currentSessionId,
  launchCoreApp,
  persistedTranscript,
  recordWebSockets,
  sandboxProcesses,
  storedSessionForMarker,
  waitForInteractive,
  writeProviderHome,
  type WsRecorder
} from './harness'
import { shellQuote } from './process-census'
import { gate, startScriptedProvider } from './provider'

// Keep this integration run out of /tmp and away from the installed app's
// profile. The harness creates a unique HOME/HERMES_HOME/userData below it.
process.env.HERMES_E2E_CORE_ROOT ??= path.join(
  process.env.HOME ?? os.homedir(),
  '.hermes',
  'cache',
  'scratch',
  'session-workspace-native'
)

const nonce = Math.random()
  .toString(36)
  .slice(2, 8)
  .replace(/[^a-z0-9]/g, 'x')
  .padEnd(4, 'q')

const U = (n: number) => `U${n}-${nonce}`
const A = (n: number) => `A${n}-${nonce}`

function promptSubmits(ws: WsRecorder, marker: string) {
  return ws.sent.filter(frame => frame.method === 'prompt.submit' && String(frame.params?.text ?? '').includes(marker))
}

async function observeNativeApiIpc(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as any)._invokeHandlers as Map<string, (...args: any[]) => Promise<any>>
    const original = handlers.get('hermes:api')

    if (!original) {
      throw new Error('native IPC handler hermes:api is missing')
    }

    const calls: { method: string; path: string }[] = []

    ;(globalThis as any).__sessionWorkspaceNativeApiCalls = calls

    // Observe, then forward to the production Electron handler unchanged. This
    // records the real renderer -> preload -> IPC -> gateway request path.
    ipcMain.removeHandler('hermes:api')
    ipcMain.handle('hermes:api', async (event: unknown, request: any) => {
      calls.push({
        method: String(request?.method ?? 'GET').toUpperCase(),
        path: String(request?.path ?? '').split('?')[0]
      })

      return original(event, request)
    })
  })
}

async function sendInTile(tile: Locator, text: string, ws: WsRecorder): Promise<void> {
  const box = tile.locator('[data-slot="composer-root"] [contenteditable="true"]').filter({ visible: true }).first()
  const probe = text.slice(0, 12)

  await box.click()
  await box.fill(text)
  await expect(box).toContainText(probe)
  await expect
    .poll(
      async () => {
        const submitted = promptSubmits(ws, probe).length > 0

        if (submitted) {
          return 'submitted'
        }

        const draft = (await box.textContent().catch(() => '')) ?? ''

        if (draft.includes(probe)) {
          await box.press('Enter')
        }

        return 'pending'
      },
      { timeout: 120_000, intervals: [1_000, 2_000, 4_000], message: `tile composer submitted ${probe}` }
    )
    .toBe('submitted')
}

test('Session Workspace opens four owner-routed chats and sends/cancels through native IPC', async () => {
  test.setTimeout(300_000)

  const provider = await startScriptedProvider()
  const sandbox = createCoreSandbox('session-workspace-native')
  writeProviderHome(sandbox.hermesHome, provider.url, '', 'manual')

  let app: ElectronApplication | undefined
  let ws: WsRecorder | undefined
  const storedIds: string[] = []
  const initialRuntimeIds: string[] = []

  try {
    const launched = await launchCoreApp(coreAppEnv(sandbox))
    app = launched.app
    const { page } = launched
    ws = recordWebSockets(page)
    await waitForInteractive(app, page)

    const isolation = await app.evaluate(({ app }) => ({
      home: process.env.HERMES_HOME ?? '',
      userData: app.getPath('userData'),
      ignoreExisting: process.env.HERMES_DESKTOP_IGNORE_EXISTING ?? '',
      appName: process.env.HERMES_DESKTOP_APP_NAME ?? ''
    }))

    expect(isolation.home).toBe(sandbox.hermesHome)
    expect(isolation.userData).toBe(sandbox.userDataDir)
    expect(isolation.userData).not.toBe(isolation.home)
    expect(isolation.ignoreExisting).toBe('1')
    expect(isolation.appName).toContain('HermesCoreE2E-')
    expect(new URL(provider.url).hostname).toBe('127.0.0.1')

    await observeNativeApiIpc(app)

    for (let n = 1; n <= 4; n++) {
      if (n > 1) {
        await page.evaluate(() => {
          window.location.hash = '#/'
        })
        await expect.poll(() => currentSessionId(page)).toBe('')
      }

      provider.script(U(n), [{ text: [`${A(n)} synthetic answer ${n}${n === 1 ? Array.from({ length: 70 }, (_, line) => `\n\nSynthetic reading-position line ${line + 1}.`).join('') : ''}`] }])
      await page.locator('[data-slot="composer-root"] [contenteditable="true"]').filter({ visible: true }).first().click()
      const composer = page.locator('[data-slot="composer-root"] [contenteditable="true"]').filter({ visible: true }).first()
      const prompt = `${U(n)} native workspace fixture ${n}`
      await composer.fill(prompt)
      await expect(composer).toContainText(prompt.slice(0, 12))

      // Use the existing harness send helper's retry rule: retry Enter only
      // while the draft remains and no matching gateway frame has been sent.
      await expect
        .poll(
          async () => {
            if (promptSubmits(ws!, U(n)).length > 0) {
              return 'submitted'
            }

            const draft = (await composer.textContent().catch(() => '')) ?? ''

            if (draft.includes(U(n))) {
              await composer.press('Enter')
            }

            return 'pending'
          },
          { timeout: 120_000, intervals: [1_000, 2_000, 4_000], message: `new chat ${n} submitted` }
        )
        .toBe('submitted')

      await expect.poll(() => provider.completions.some(item => item.marker === U(n) && item.finished)).toBe(true)
      await expect.poll(() => currentSessionId(page)).not.toBe('')
      await expect
        .poll(() => storedSessionForMarker(sandbox, 'default', U(n)), { message: `isolated state.db row for ${U(n)}` })
        .not.toBeNull()
      const storedId = storedSessionForMarker(sandbox, 'default', U(n))
      expect(storedId).toBeTruthy()
      storedIds.push(storedId!)

      const submit = promptSubmits(ws, U(n)).at(-1)
      expect(submit?.params?.session_id).toBeTruthy()
      initialRuntimeIds.push(String(submit!.params.session_id))
    }

    expect(new Set(storedIds).size).toBe(4)
    expect(new Set(initialRuntimeIds).size).toBe(4)
    expect(ws.sockets).toHaveLength(1)
    expect(new URL(ws.sockets[0].url).hostname).toBe('127.0.0.1')

    // Exercise the exposed preload API directly and observe the unchanged native
    // `hermes:api` handler forwarding the roster read to the isolated gateway.
    const roster = await page.evaluate(async () => {
      const bridge = (window as any).hermesDesktop

      const response = await bridge.api({
        path: '/api/sessions?limit=40&offset=0&min_messages=0&archived=exclude&order=recent'
      })

      return {
        hasNativeApi: typeof bridge.api === 'function',
        ids: (response?.sessions ?? []).map((session: any) => String(session.id))
      }
    })

    expect(roster.hasNativeApi).toBe(true)
    expect(roster.ids).toHaveLength(4)
    expect(new Set(roster.ids).size).toBe(4)
    expect([...roster.ids].sort()).toEqual([...storedIds].sort())

    await page.evaluate(() => {
      window.location.hash = '#/capabilities?tab=plugins'
    })
    const catalogFilters = page.locator('[data-catalog-filters]')
    await catalogFilters.getByRole('button', { name: /Filters/ }).click()
    const installedFilter = page.locator('[data-catalog-expanded-filters]').getByRole('button', { name: 'Installed' })
    await expect(installedFilter).toBeVisible()
    await expect(installedFilter).toHaveAttribute('aria-pressed', 'false')
    await installedFilter.click()
    const pluginSwitch = page.getByRole('switch', { name: 'Session Workspace' })

    try {
      await expect(pluginSwitch).toBeVisible({ timeout: 10_000 })
    } catch (error) {
      const catalog = page.locator('[data-catalog="plugins"]')
      const catalogText = await catalog.innerText().catch(() => '<catalog unavailable>')
      const rowIds = await page.locator('[data-testid^="plugin-row-"]').evaluateAll(rows => rows.map(row => row.getAttribute('data-testid')))
      throw new Error(`Session Workspace switch missing; catalog rows=${JSON.stringify(rowIds)}; catalog text=${catalogText.slice(0, 1600)}; cause=${String(error)}`)
    }

    await expect(pluginSwitch).toHaveAttribute('aria-checked', 'false')
    await pluginSwitch.click()
    await expect(pluginSwitch).toHaveAttribute('aria-checked', 'true')

    await page.evaluate(() => {
      window.location.hash = '#/'
    })
    await expect.poll(() => currentSessionId(page)).toBe('')
    await page.evaluate(() => {
      window.location.hash = '#/session-workspace'
    })
    await expect(page.getByRole('heading', { name: /Workspace|ワークスペース/ }).first()).toBeVisible()

    for (let n = 1; n <= 4; n++) {
      await page.getByRole('main').getByRole('button', { name: /Add session|セッションを追加/ }).first().click()
      const dialog = page.getByRole('dialog')
      const search = dialog.locator('input[type="search"]')
      await search.fill(storedIds[n - 1])
      const candidate = dialog.locator('ul > li > button')
      await expect(candidate).toHaveCount(1)
      await expect(candidate).toBeEnabled()
      await candidate.click()

      const tile = page.locator('section.session-workspace-card[aria-label]').filter({ hasText: A(n) })
      await expect(tile).toHaveCount(1)
      await expect(tile).toContainText(A(n))
      await expect(tile.locator('.session-workspace-status')).toHaveAttribute('title', /default/)
    }

    await expect(page.locator('section.session-workspace-card[aria-label]')).toHaveCount(4)
    const tileOne = page.locator('section.session-workspace-card[aria-label]').filter({ hasText: A(1) })
    const tileTwo = page.locator('section.session-workspace-card[aria-label]').filter({ hasText: A(2) })

    provider.script(U(5), [{ text: [`${A(5)} sent from tile one`] }])
    await sendInTile(tileOne, `${U(5)} follow-up owned by tile one`, ws)
    await expect(tileOne).toContainText(A(5))

    const cancelGate = gate()
    provider.script(U(6), [{ text: [`${A(6)} held until stop`], holdAfterFirstChunk: cancelGate }])
    await sendInTile(tileTwo, `${U(6)} cancel from tile two`, ws)
    await provider.streamStarted(U(6))
    await expect(tileTwo).toContainText(A(6))
    await tileTwo.locator('[data-slot="composer-root"] button[aria-label="Stop"]').filter({ visible: true }).click()

    const cancelSubmit = promptSubmits(ws, U(6)).at(-1)
    expect(cancelSubmit?.params?.session_id).toBeTruthy()
    await expect
      .poll(
        () =>
          ws!.sent.some(
            frame => frame.method === 'session.interrupt' && frame.params?.session_id === cancelSubmit?.params?.session_id
          ),
        { timeout: 60_000, message: 'Stop sent session.interrupt to the submitting tile session' }
      )
      .toBe(true)
    await expect.poll(() => provider.completions.some(item => item.marker === U(6) && item.aborted)).toBe(true)

    await expect
      .poll(() => storedSessionForMarker(sandbox, 'default', U(5)), { message: 'tile one follow-up persisted to its owner session' })
      .toBe(storedIds[0])
    await expect
      .poll(() => storedSessionForMarker(sandbox, 'default', U(6)), { message: 'tile two cancel prompt persisted to its owner session' })
      .toBe(storedIds[1])

    const [tileOneTranscript, tileTwoTranscript] = await Promise.all([
      persistedTranscript(page, storedIds[0]),
      persistedTranscript(page, storedIds[1])
    ])

    const transcriptText = (messages: { content: string }[]) => messages.map(message => message.content).join('\n')
    expect(transcriptText(tileOneTranscript)).toContain(U(5))
    expect(transcriptText(tileOneTranscript)).toContain(A(5))
    expect(transcriptText(tileTwoTranscript)).toContain(U(6))
    expect(transcriptText(tileTwoTranscript)).toContain(A(6))

    const nativeApiCalls = await app.evaluate(() => (globalThis as any).__sessionWorkspaceNativeApiCalls ?? [])
    const apiPaths = (nativeApiCalls as { method: string; path: string }[]).map(call => call.path)
    expect(apiPaths).toContain('/api/sessions')

    for (const id of storedIds) {
      expect(apiPaths).toContain(`/api/sessions/${id}/timeline`)
    }

    const submittedMarkers = Array.from({ length: 6 }, (_, index) => U(index + 1))

    for (const marker of submittedMarkers) {
      expect(promptSubmits(ws, marker)).toHaveLength(1)
    }

    const interruptRequests = ws.sent.filter(frame => frame.method === 'session.interrupt')
    expect(interruptRequests).toHaveLength(1)
    expect(interruptRequests[0].params?.session_id).toBe(cancelSubmit!.params.session_id)
    expect(cancelSubmit!.params.session_id).not.toBe(promptSubmits(ws, U(5))[0].params.session_id)
    expect(provider.completions).toHaveLength(6)
    expect(provider.completions.map(item => item.marker).sort()).toEqual([...submittedMarkers].sort())
    expect(provider.completions.filter(item => item.finished).map(item => item.marker).sort()).toEqual(
      [U(1), U(2), U(3), U(4), U(5)].sort()
    )
    expect(provider.completions.filter(item => item.aborted).map(item => item.marker)).toEqual([U(6)])

    const tileThree = page.locator('section.session-workspace-card[aria-label]').filter({ hasText: A(3) })
    const tileFour = page.locator('section.session-workspace-card[aria-label]').filter({ hasText: A(4) })
    const victims = [7, 8].map(n => path.join(sandbox.root, `synthetic-approval-${n}`))
    victims.forEach(victim => fs.mkdirSync(victim))

    for (const n of [7, 8]) {
      provider.script(U(n), [{ text: [`Approval ${n} `], toolCalls: [{ name: 'terminal', args: { command: `rm -rf ${shellQuote(victims[n - 7])}` } }] }, { text: [`${A(n)} fixture resolved`] }])
    }

    await sendInTile(tileThree, `${U(7)} approval fixture one`, ws)
    await sendInTile(tileFour, `${U(8)} approval fixture two`, ws)
    await expect(tileThree.locator('[data-approval-deny]')).toBeVisible({ timeout: 120000 })
    await expect(tileFour.locator('[data-approval-run]')).toBeVisible({ timeout: 120000 })
    expect(victims.every(victim => fs.existsSync(victim))).toBe(true)
    await tileThree.locator('[data-approval-deny]').click()
    await expect(tileFour.locator('[data-approval-run]')).toBeVisible()
    await tileFour.locator('[data-approval-run]').click()
    await expect.poll(() => fs.existsSync(victims[1])).toBe(false)
    expect(fs.existsSync(victims[0])).toBe(true)
    await expect(tileThree).toContainText(A(7))
    await expect(tileFour).toContainText(A(8))
    await page.setViewportSize({ width: 1600, height: 1000 })
    const draft = tileOne.locator('[data-slot="composer-root"] [contenteditable="true"]').filter({ visible: true }).first()
    await draft.click()
    await draft.fill('日本語の下書き。移動しても保持する。')
    await expect(draft).toContainText('日本語の下書き')
    const draftHandle = await draft.elementHandle()
    const transcript = tileOne.locator('[data-slot="aui_thread-viewport"]').first()
    await transcript.evaluate(node => { node.scrollTop = 100 })
    await expect.poll(() => transcript.evaluate(node => node.scrollTop)).toBe(100)
    const mover = tileOne.locator('..').locator('.session-workspace-move')
    const start = await mover.boundingBox()
    const target = await page.locator('[data-workspace-slot="2"]').boundingBox()
    expect(start).toBeTruthy()
    expect(target).toBeTruthy()
    await page.mouse.move(start!.x + 8, start!.y + 8)
    await page.mouse.down()
    await page.mouse.move(target!.x + target!.width / 2, target!.y + 50, { steps: 12 })
    await expect(page.locator('.session-workspace-drop')).toBeVisible()
    await page.screenshot({ path: path.join(process.env.HERMES_E2E_CORE_ROOT!, 'v2-native-drag.png') })
    await page.mouse.up()
    await expect(tileOne.locator('..')).toHaveAttribute('data-workspace-slot', '2')
    expect(await draftHandle!.evaluate(node => node.isConnected)).toBe(true)
    await expect(draft).toContainText('日本語の下書き')
    expect(await transcript.evaluate(node => node.scrollTop)).toBe(100)
    await mover.click()

    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Escape')

    await expect(mover).toBeFocused({ timeout: 5000 })
    await mover.click()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Enter')
    await expect(tileOne.locator('..')).toHaveAttribute('data-workspace-slot', '1')
    const rosterSource = page.getByRole('button', { name: `${U(1)} native workspace fixture 1`, exact: true }).first()
    const rosterRect = await rosterSource.boundingBox()
    const firstPane = await page.locator('[data-workspace-slot="0"]').boundingBox()
    await page.mouse.move(rosterRect!.x + 12, rosterRect!.y + 8)
    await page.mouse.down()
    await page.mouse.move(firstPane!.x + 10, firstPane!.y + 80, { steps: 15 })
    await expect(page.locator('.session-workspace-drop[data-edge="before"]')).toBeVisible()
    await page.screenshot({ path: path.join(process.env.HERMES_E2E_CORE_ROOT!, 'v2-native-roster-edge.png') })
    await page.mouse.up()
    await expect(tileOne.locator('..')).toHaveAttribute('data-workspace-slot', '0')
    const sash = page.getByRole('separator', { name: /Resize columns/ })
    const sashBox = await sash.boundingBox()
    const pointerBefore = Number(await sash.getAttribute('aria-valuenow'))
    await page.mouse.move(sashBox!.x + 6, sashBox!.y + 80)
    await page.mouse.down()
    await page.mouse.move(sashBox!.x - 30, sashBox!.y + 80, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => Number(await sash.getAttribute('aria-valuenow'))).toBeLessThan(pointerBefore)
    const before = Number(await sash.getAttribute('aria-valuenow'))
    await sash.focus()
    await page.keyboard.press('ArrowLeft')
    await expect.poll(async () => Number(await sash.getAttribute('aria-valuenow'))).toBeLessThan(before)
    await page.getByRole('button', { name: 'Main + 2 side panes', exact: true }).click()
    await expect(page.locator('.session-workspace-position:not([hidden]) > section.session-workspace-card[aria-label]')).toHaveCount(3)
    await expect(page.locator('section.session-workspace-card[aria-label]')).toHaveCount(4)
    await page.getByRole('navigation', { name: 'Open sessions' }).getByRole('button').nth(3).click()
    await expect(tileFour).toBeVisible()
    await page.getByRole('navigation', { name: 'Open sessions' }).getByRole('button').first().click()
    expect(await transcript.evaluate(node => node.scrollTop)).toBe(100)
    await page.screenshot({ path: path.join(process.env.HERMES_E2E_CORE_ROOT!, 'v2-native-1600x1000.png') })
    const readability = []

    for (const width of [1600, 760]) {
      await page.setViewportSize({ width, height: 1000 })

      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        await expect(page.locator('html')).toHaveAttribute('data-hermes-mode', colorScheme)

        for (const focused of [true, false]) {
          await draft.click()
          await transcript.evaluate(async node => {
            node.scrollTop = 101
            await new Promise(requestAnimationFrame)
            node.scrollTop = 100
            node.dispatchEvent(new Event('scroll'))
          })

          if (!focused) {
            await page.getByRole('heading', { name: 'Workspace', exact: true }).click()
            await page.mouse.move(10, 10)
          }

          await expect.poll(() => transcript.evaluate(node => node.scrollTop)).toBe(100)
          await expect(tileOne.locator('[data-slot="composer-root"]')).toHaveAttribute('data-thread-scrolled-up', '')
          await expect.poll(() => tileOne.locator('[data-slot="composer-fade"]').evaluate(async node => {
            await Promise.all(node.getAnimations().map(animation => animation.finished))
            return true
          })).toBe(true)
          const metrics = await tileOne.evaluate(node => {
            const fade = node.querySelector('[data-slot="composer-fade"]')!
            const surface = node.querySelector('[data-slot="composer-surface"]')!
            const root = node.querySelector('[data-slot="composer-root"]')!
            const input = node.querySelector('[contenteditable="true"]')!
            const background = getComputedStyle(surface.firstElementChild!).backgroundColor
            const context = document.createElement('canvas').getContext('2d')!
            context.fillStyle = background
            context.fillRect(0, 0, 1, 1)
            return {
              opacity: getComputedStyle(fade).opacity,
              background,
              backgroundAlpha: context.getImageData(0, 0, 1, 1).data[3],
              fill: getComputedStyle(root).getPropertyValue('--composer-fill'),
              scrolledUp: root.hasAttribute('data-thread-scrolled-up'),
              focused: input === document.activeElement || input.contains(document.activeElement),
              draft: input.textContent,
              inputColor: getComputedStyle(input).color,
              controlColor: getComputedStyle(fade.querySelector('button')!).color
            }
          })
          readability.push({ width, colorScheme, requestedFocus: focused, ...metrics })
          await page.screenshot({ path: path.join(process.env.HERMES_E2E_CORE_ROOT!, `q1-${width}-${colorScheme}-${focused ? 'focused' : 'blurred'}.png`) })
          expect(await draftHandle!.evaluate(node => node.isConnected)).toBe(true)
          await expect(draft).toHaveText('日本語の下書き。移動しても保持する。')
        }
      }
    }

    fs.writeFileSync(path.join(process.env.HERMES_E2E_CORE_ROOT!, 'q1-readability.json'), JSON.stringify(readability, null, 2))
    await page.setViewportSize({ width: 1600, height: 1000 })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.getByRole('button', { name: 'Focus', exact: true }).first().click()
    await expect(page.locator('.session-workspace-position:not([hidden]) > section.session-workspace-card[aria-label]')).toHaveCount(1)
    expect(await draftHandle!.evaluate(node => node.isConnected)).toBe(true)
    await expect(draft).toContainText('日本語の下書き')
    await page.getByRole('button', { name: 'Main + 2 side panes', exact: true }).click()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await sash.evaluate(node => parseFloat(getComputedStyle(node, '::after').transitionDuration))).toBeLessThanOrEqual(.00001)
    await page.setViewportSize({ width: 760, height: 1000 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const visualOrder = await page.locator('.session-workspace-position:not([hidden])').evaluateAll(nodes => nodes.map(node => ({ slot: node.getAttribute('data-workspace-slot')!, top: node.getBoundingClientRect().top })).sort((a, b) => a.top - b.top))
    const lowest = page.locator(`[data-workspace-slot="${visualOrder.at(-1)!.slot}"]`)
    await lowest.scrollIntoViewIfNeeded()
    const lowestComposer = lowest.locator('[contenteditable="true"]').first()
    await expect(lowestComposer).toBeInViewport()
    const reachable = await lowestComposer.evaluate(node => {
      const box = node.getBoundingClientRect()
      const board = node.closest('.session-workspace-board')!.getBoundingClientRect()
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return { top: box.top, bottom: box.bottom, boardTop: board.top, boardBottom: board.bottom, hit: node === hit || node.contains(hit) }
    })
    expect(reachable.top).toBeGreaterThanOrEqual(reachable.boardTop)
    expect(reachable.bottom).toBeLessThanOrEqual(reachable.boardBottom)
    expect(reachable.hit).toBe(true)
    fs.writeFileSync(path.join(process.env.HERMES_E2E_CORE_ROOT!, 'narrow-lowest.json'), JSON.stringify({ visualOrder, reachable }, null, 2))
    await page.screenshot({ path: path.join(process.env.HERMES_E2E_CORE_ROOT!, 'v2-native-narrow.png') })
    await page.setViewportSize({ width: 1600, height: 1000 })
    await page.getByRole('button', { name: '2×2', exact: true }).click()
    await expect(draft).toContainText('日本語の下書き')
    expect(await draftHandle!.evaluate(node => node.isConnected)).toBe(true)
    await expect(page.getByRole('main').getByRole('button', { name: 'New session', exact: true }).first()).toBeDisabled()
    const fourth = page.locator('[data-workspace-slot="3"] section')
    await fourth.locator('header button').last().click()
    await page.getByRole('main').getByRole('button', { name: 'New session', exact: true }).first().click()
    const createDialog = page.getByRole('dialog')
    await expect(createDialog.getByRole('combobox', { name: 'Owner' })).toHaveValue(/default/)
    await createDialog.getByRole('textbox').fill('Workspace native created')
    await page.screenshot({ path: path.join(process.env.HERMES_E2E_CORE_ROOT!, 'v2-native-create.png') })
    const createsBefore = ws.sent.filter(frame => frame.method === 'session.create').length
    await createDialog.getByRole('button', { name: 'Create session', exact: true }).click()
    await expect(createDialog).not.toBeVisible()
    await expect.poll(() => ws!.sent.filter(frame => frame.method === 'session.create').length).toBe(createsBefore + 1)
    const createdTile = page.locator('section.session-workspace-card').filter({ has: page.getByRole('heading', { name: 'Workspace native created', exact: true }) })
    await expect(createdTile).toBeVisible()
    await expect(createdTile.locator('[contenteditable="true"]').first()).toBeFocused()
    await expect(draft).toContainText('日本語の下書き')
    const arrangement = await page.locator('[data-workspace-slot]').evaluateAll(nodes => nodes.map(node => ({ index: node.getAttribute('data-workspace-slot'), id: node.querySelector('[data-workspace-session]')?.getAttribute('data-workspace-session') })).sort((a, b) => Number(a.index) - Number(b.index)))
    const splitRatio = await sash.getAttribute('aria-valuenow')
    await page.reload()
    await waitForInteractive(app, page)
    await page.getByRole('button', { name: 'Workspace', exact: true }).click()
    await expect(page.locator('section.session-workspace-card[aria-label]')).toHaveCount(4)
    expect(await page.locator('[data-workspace-slot]').evaluateAll(nodes => nodes.map(node => ({ index: node.getAttribute('data-workspace-slot'), id: node.querySelector('[data-workspace-session]')?.getAttribute('data-workspace-session') })).sort((a, b) => Number(a.index) - Number(b.index)))).toEqual(arrangement)
    await expect(page.getByRole('separator', { name: /Resize columns/ })).toHaveAttribute('aria-valuenow', splitRatio!)
    for (const sample of readability) {
      expect.soft(sample.focused, JSON.stringify(sample)).toBe(sample.requestedFocus)
      expect.soft(sample.scrolledUp, JSON.stringify(sample)).toBe(true)
      expect.soft(sample.opacity, JSON.stringify(sample)).toBe('1')
      expect.soft(sample.backgroundAlpha, JSON.stringify(sample)).toBe(255)
    }
    console.log('V2_NATIVE gestures=tile+roster-edge+keyboard escape=focus-return draft=retained preset=3-visible+4-reachable approvals=2-owner-runtime-scoped creation=production-contract new-composer=focused capacity=disabled narrow=no-document-overflow reduced-motion=reduce persistence=reload')
    console.log(
      `NATIVE_SESSION_WORKSPACE_SMOKE isolation=verified roster=4 tiles=4 ipc_api_paths=${new Set(apiPaths).size} ` +
        `gateway_ws=${ws.sockets.length} unique_initial_sessions=${new Set(initialRuntimeIds).size} ` +
        `prompt_submit=6 session_interrupt=1 fake_provider_finished=5 fake_provider_aborted=1`
    )
  } finally {
    await app?.close().catch(() => undefined)
    await provider.close().catch(() => undefined)
    sandbox.cleanup()
  }

  expect(sandboxProcesses(sandbox)).toEqual([])
})
