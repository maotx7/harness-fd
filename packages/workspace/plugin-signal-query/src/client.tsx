import { useCallback, useEffect, useRef, useState } from 'react'
import { Database, RefreshCw, Trash2, Upload } from 'lucide-react'

export const name = 'signal-matrix-ui'
export const inject = ['slots', 'layout']

const PANEL_ID = 'signal-matrices'

interface Matrix {
  id: string
  project_code: string
  network_name: string
  owner_node: string
  version_label: string
  status: string
  source_filename: string
  message_count: number
  signal_count: number
  created_at: string
}

interface PanelProps {
  apiBase: string
}

export function apply(ctx: any) {
  ctx.slots.inject('main', function* () {
    yield ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      inject: () => ({ apiBase: '/api/workspace/signals' })
    }, SignalMatrixPanel)
  })

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 20,
    label: () => '信号矩阵'
  }, SignalMatrixIcon))
}

function SignalMatrixIcon({ size, active }: { size: number; active: boolean }) {
  return <Database size={size} strokeWidth={active ? 2.2 : 1.8} aria-hidden="true" />
}

function SignalMatrixPanel({ apiBase }: PanelProps) {
  const [matrices, setMatrices] = useState<Matrix[]>([])
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch(apiBase)
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || '加载信号矩阵失败')
      setMatrices(body.matrices)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '加载信号矩阵失败')
    } finally {
      setLoading(false)
    }
  }, [apiBase])

  useEffect(() => {
    void load()
  }, [load])

  const upload = async (file: File) => {
    setUploading(true)
    setError('')
    try {
      const form = new FormData()
      form.append('file', file)
      const response = await fetch(apiBase, { method: 'POST', body: form })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || '导入信号矩阵失败')
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导入信号矩阵失败')
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const remove = async (matrix: Matrix) => {
    if (matrix.status !== 'DRAFT') return
    if (!window.confirm(`删除草稿 ${matrix.project_code} / ${matrix.version_label}？`)) return
    const response = await fetch(
      `${apiBase}/${encodeURIComponent(matrix.id)}`,
      { method: 'DELETE' }
    )
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      setError(body.error || '删除失败')
      return
    }
    await load()
  }

  return (
    <main style={styles.shell}>
      <header style={styles.header}>
        <div><h1 style={styles.title}>信号矩阵</h1><p style={styles.subtitle}>管理全局通用的信号矩阵版本</p></div>
        <div style={styles.actions}>
          <input ref={fileInput} type="file" accept=".xlsx,.xls,.csv" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file) }} />
          <button type="button" style={styles.secondaryButton} disabled={uploading} onClick={() => fileInput.current?.click()}><Upload size={16} />{uploading ? '解析中...' : '上传矩阵'}</button>
          <button type="button" style={styles.iconButton} onClick={() => void load()} title="刷新"><RefreshCw size={17} aria-hidden="true" /></button>
        </div>
      </header>

      {error && <div role="alert" style={styles.error}>{error}</div>}

      <section style={styles.tableSection} aria-busy={loading}>
        <div style={styles.tableHeader}>
          <span>{loading ? '正在读取...' : `${matrices.length} 个版本`}</span>
          <span>仅草稿可删除</span>
        </div>
        {matrices.length === 0 && !loading ? (
          <div style={styles.empty}>暂无矩阵，上传 XLSX、XLS 或 CSV 文件开始构建信号库。</div>
        ) : (
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  {['项目', '网络 / 节点', '版本', '状态', '规模', '源文件', ''].map((label) => (
                    <th key={label} style={styles.th}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrices.map((matrix) => (
                  <tr key={matrix.id} style={styles.row}>
                    <td style={styles.tdStrong}>{matrix.project_code}</td>
                    <td style={styles.td}>{matrix.network_name}<br /><span style={styles.muted}>{matrix.owner_node}</span></td>
                    <td style={styles.tdStrong}>{matrix.version_label}</td>
                    <td style={styles.td}><span style={statusStyle(matrix.status)}>{matrix.status}</span></td>
                    <td style={styles.td}>{matrix.message_count} 消息<br /><span style={styles.muted}>{matrix.signal_count} 信号</span></td>
                    <td style={styles.td}>{matrix.source_filename}</td>
                    <td style={styles.actionCell}>
                      <button
                        type="button"
                        style={{ ...styles.deleteButton, opacity: matrix.status === 'DRAFT' ? 1 : 0.3 }}
                        disabled={matrix.status !== 'DRAFT'}
                        onClick={() => void remove(matrix)}
                        title="删除草稿"
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  )
}

const styles: Record<string, React.CSSProperties> = {
  shell: { minHeight: '100%', padding: '28px 32px', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', maxWidth: 960, margin: '0 auto 24px' },
  title: { margin: 0, fontSize: 24, lineHeight: 1.3, fontWeight: 600, letterSpacing: 0 },
  subtitle: { margin: '6px 0 0', color: 'var(--dsw-alias-label-secondary)', fontSize: 13 },
  actions: { display: 'flex', alignItems: 'center', gap: 8 },
  iconButton: { width: 32, height: 32, display: 'grid', placeItems: 'center', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'var(--dsw-alias-button-floating-fill)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' },
  secondaryButton: { height: 32, padding: '0 11px', display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'var(--dsw-alias-button-floating-fill)', color: 'var(--dsw-alias-label-primary)', fontWeight: 500, cursor: 'pointer' },
  error: { maxWidth: 960, margin: '0 auto 16px', padding: '10px 12px', border: '1px solid var(--dsw-alias-state-error-primary)', borderRadius: 6, color: 'var(--dsw-alias-state-error-primary)' },
  tableSection: { maxWidth: 960, margin: '0 auto', background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, overflow: 'hidden' },
  tableHeader: { minHeight: 42, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 14px', borderBottom: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
  tableWrap: { overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', fontSize: 13 },
  th: { padding: '10px 12px', textAlign: 'left', color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)', borderBottom: '1px solid var(--dsw-alias-border-l1)', fontSize: 11, fontWeight: 600 },
  row: { borderBottom: '1px solid var(--dsw-alias-border-l1)' },
  td: { padding: '13px 12px', verticalAlign: 'middle', overflowWrap: 'anywhere' },
  tdStrong: { padding: '13px 12px', verticalAlign: 'middle', fontWeight: 650, overflowWrap: 'anywhere' },
  muted: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 },
  actionCell: { width: 44, padding: '8px', textAlign: 'right' },
  deleteButton: { width: 32, height: 32, display: 'inline-grid', placeItems: 'center', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', cursor: 'pointer' },
  empty: { minHeight: 220, display: 'grid', placeItems: 'center', color: 'var(--dsw-alias-label-tertiary)', padding: 24 },
}

function statusStyle(status: string): React.CSSProperties {
  const active = status === 'ACTIVE'
  const draft = status === 'DRAFT'
  return {
    display: 'inline-block',
    padding: '3px 7px',
    border: '1px solid var(--dsw-alias-border-l2)',
    color: active ? 'var(--dsw-alias-state-success-primary)' : draft ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-secondary)',
    background: 'var(--dsw-alias-bg-layer-2)',
    fontSize: 10,
    fontWeight: 750
  }
}