export const SESSION_WORKSPACE_LOCALES = {
  en: {
    nav: 'Workspace',
    openCommand: 'Open session workspace',
    page: {
      title: 'Workspace',
      selectedCount: (count: number, max: number) => `${count} / ${max} sessions`,
      addSession: 'Add session',
      layout: 'Workspace layout',
      grid: '2×2',
      focus: 'Focus',
      emptyTitle: 'Choose sessions to begin',
      emptyBody: 'Select up to four existing sessions.',
      loading: 'Loading sessions…',
      loadError: 'The session list could not be loaded.',
      noSessions: 'No sessions available.',
      noMatches: 'No matching sessions.',
      missingPane: 'This saved session pane is unavailable.',
      remove: (title: string) => `Remove ${title} from workspace`
    },
    picker: {
      title: 'Add sessions',
      description: 'Choose an existing session to open as an independent chat.',
      search: 'Search sessions',
      add: 'Add',
      addAria: (title: string) => `Add ${title}`,
      inWorkspace: 'In workspace',
      inMain: 'In main chat',
      ownerUnavailable: 'Owner unavailable',
      routeConflict: 'Already open from another connection',
      aliasConflict: 'Already open with another session ID',
      limit: 'Workspace full'
    },
    status: {
      background: 'Working in background',
      draft: 'Draft',
      idle: 'Idle',
      needsInput: 'Needs input',
      stalled: 'Stalled',
      unread: 'Unread',
      working: 'Working'
    }
  },
  ja: {
    nav: 'ワークスペース',
    openCommand: 'セッションワークスペースを開く',
    page: {
      title: 'ワークスペース',
      selectedCount: (count: number, max: number) => `${count} / ${max} セッション`,
      addSession: 'セッションを追加',
      layout: 'ワークスペースのレイアウト',
      grid: '2×2',
      focus: 'フォーカス',
      emptyTitle: 'セッションを選択してください',
      emptyBody: '既存のセッションを最大4件選択できます。',
      loading: 'セッションを読み込み中…',
      loadError: 'セッション一覧を読み込めませんでした。',
      noSessions: '利用できるセッションはありません。',
      noMatches: '一致するセッションはありません。',
      missingPane: '保存されたセッションペインを利用できません。',
      remove: (title: string) => `${title} をワークスペースから削除`
    },
    picker: {
      title: 'セッションを追加',
      description: '独立したチャットとして開く既存セッションを選択します。',
      search: 'セッションを検索',
      add: '追加',
      addAria: (title: string) => `${title} を追加`,
      inWorkspace: '追加済み',
      inMain: 'メインチャットで表示中',
      ownerUnavailable: '接続先を特定できません',
      routeConflict: '別の接続先で既に開いています',
      aliasConflict: '別のセッションIDで既に開いています',
      limit: 'ワークスペースは満員です'
    },
    status: {
      background: 'バックグラウンドで実行中',
      draft: '下書き',
      idle: '待機中',
      needsInput: '入力待ち',
      stalled: '停止中',
      unread: '未読',
      working: '作業中'
    }
  }
} as const
