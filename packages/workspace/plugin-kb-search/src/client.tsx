import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, RefreshCw, Trash2, Upload } from 'lucide-react'

export const name = 'knowledge-base-ui'
export const inject = ['slots', 'layout']

// Keep the workspace UI neutral while preserving the host layout. These are
// official DSH brand slots, so replacing them is more stable than targeting
// generated CSS module class names.
const EmptyBrandMark = () => null

interface DocumentSummary {
  id: string
  title: string
  status: string
  created_by: string | null
  version_count: number
  source_filename: string | null
  source_size: number | null
  updated_at: string
}

export function apply(ctx: any) {
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register(
    { name: 'sidebar.brand.mark' },
    EmptyBrandMark,
  ))
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register(
    { name: 'conversation.hero.brand.mark' },
    EmptyBrandMark,
  ))

  ctx.slots.inject('main', function* () {
    yield ctx.slots.register({ name: 'main', key: 'knowledge-base' }, KnowledgeBasePanel)
  })
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: 'knowledge-base', order: 19, label: () => '知识库'
  }, ({ size, active }: { size: number; active: boolean }) => (
    <BookOpen size={size} strokeWidth={active ? 2.2 : 1.8} aria-hidden="true" />
  )))
}

function KnowledgeBasePanel() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [indexingId, setIndexingId] = useState('')
  const [error, setError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/workspace/knowledge')
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || '加载知识库失败')
      setDocuments(body.documents)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '加载知识库失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const upload = async (file: File) => {
    setUploading(true)
    setError('')
    try {
      const form = new FormData()
      form.append('file', file)
      const response = await fetch('/api/workspace/knowledge', { method: 'POST', body: form })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || '上传文档失败')
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '上传文档失败')
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const remove = async (document: DocumentSummary) => {
    if (!window.confirm(`删除知识库文档“${document.title}”？`)) return
    setError('')
    const response = await fetch(`/api/workspace/knowledge/${encodeURIComponent(document.id)}`, { method: 'DELETE' })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      setError(body.error || '删除文档失败')
      return
    }
    await load()
  }

  const reindex = async (document: DocumentSummary) => {
    setIndexingId(document.id)
    setError('')
    try {
      const response = await fetch(`/api/workspace/knowledge/${encodeURIComponent(document.id)}/index`, { method: 'POST' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || '重新向量化失败')
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '重新向量化失败')
    } finally {
      setIndexingId('')
    }
  }

  return <main style={styles.shell}>
    <header style={styles.header}>
      <div><h1 style={styles.title}>知识库</h1><p style={styles.subtitle}>管理全局通用的文档与版本</p></div>
      <div style={styles.actions}>
        <input ref={fileInput} type="file" accept=".pdf,.docx,.doc" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file) }} />
        <button type="button" style={styles.secondaryButton} disabled={uploading} onClick={() => fileInput.current?.click()}><Upload size={16} />{uploading ? '上传中...' : '上传文档'}</button>
        <button type="button" style={styles.iconButton} onClick={() => void load()} title="刷新"><RefreshCw size={17} /></button>
      </div>
    </header>
    {error && <div role="alert" style={styles.error}>{error}</div>}
    <section style={styles.list} aria-busy={loading}>
      <div style={styles.listHeader}><span>{loading ? '正在读取...' : `${documents.length} 个文档`}</span><span>正式知识目录</span></div>
      {!loading && documents.length === 0 ? <div style={styles.empty}>暂无文档，上传 PDF、DOCX 或 DOC 文件开始构建知识库。</div> : documents.map(document => (
        <div key={document.id} style={styles.row}>
          <BookOpen size={18} style={styles.rowIcon} />
          <div style={styles.rowMain}><strong style={styles.documentTitle}>{document.title}</strong><span style={styles.meta}>{document.source_filename || '未知文件'} · {formatSize(document.source_size)} · {new Date(document.updated_at).toLocaleString()}</span></div>
          <div style={styles.rowActions}>
            <span style={styles.version}>{document.version_count} 个版本</span>
            <span style={styles.status}>{document.status}</span>
            <button type="button" style={styles.indexButton} disabled={Boolean(indexingId)} onClick={() => void reindex(document)} title="重新向量化"><RefreshCw size={15} /></button>
            <button type="button" style={styles.deleteButton} onClick={() => void remove(document)} title="删除文档"><Trash2 size={15} /></button>
          </div>
        </div>
      ))}
    </section>
  </main>
}

const styles: Record<string, React.CSSProperties> = {
  shell: { minHeight: '100%', padding: '28px 32px', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit' },
  header: { maxWidth: 960, margin: '0 auto 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  title: { margin: 0, fontSize: 24, lineHeight: 1.3, fontWeight: 600 },
  subtitle: { margin: '6px 0 0', color: 'var(--dsw-alias-label-secondary)', fontSize: 13 },
  actions: { display: 'flex', alignItems: 'center', gap: 8 },
  iconButton: { width: 32, height: 32, display: 'grid', placeItems: 'center', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'var(--dsw-alias-button-floating-fill)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' },
  secondaryButton: { height: 32, padding: '0 11px', display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'var(--dsw-alias-button-floating-fill)', color: 'var(--dsw-alias-label-primary)', fontWeight: 500, whiteSpace: 'nowrap', cursor: 'pointer' },
  error: { maxWidth: 960, margin: '0 auto 16px', padding: '10px 12px', border: '1px solid var(--dsw-alias-state-error-primary)', borderRadius: 6, color: 'var(--dsw-alias-state-error-primary)' },
  list: { maxWidth: 960, margin: '0 auto', overflow: 'hidden', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)' },
  listHeader: { minHeight: 42, padding: '0 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
  row: { minHeight: 64, display: 'grid', gridTemplateColumns: '28px minmax(120px, 1fr) auto', gap: 12, alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
  rowIcon: { color: 'var(--dsw-alias-label-secondary)' },
  rowMain: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 },
  rowActions: { display: 'flex', alignItems: 'center', gap: 12, whiteSpace: 'nowrap' },
  documentTitle: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 550 },
  meta: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 },
  version: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
  status: { padding: '3px 7px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)', fontSize: 10 },
  indexButton: { width: 30, height: 30, display: 'grid', placeItems: 'center', border: 0, borderRadius: 6, background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' },
  deleteButton: { width: 30, height: 30, display: 'grid', placeItems: 'center', border: 0, borderRadius: 6, background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', cursor: 'pointer' },
  empty: { minHeight: 220, display: 'grid', placeItems: 'center', padding: 24, color: 'var(--dsw-alias-label-tertiary)' }
}

function formatSize(value: number | null) {
  if (!value) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}
