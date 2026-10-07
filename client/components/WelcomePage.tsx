import React, { useState } from 'react'
import './WelcomePage.css'

export function WelcomePage({ onLoginSuccess }: { onLoginSuccess: (user: any, token: string) => void }) {
  const [username, setUsername] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleLogin = async () => {
    if (!username || username.length < 2) {
      setError('请输入用户名（2-20字符）')
      return
    }

    if (!/^[一-龥a-zA-Z0-9_]+$/.test(username)) {
      setError('用户名只能包含中文、字母、数字和下划线')
      return
    }

    setLoading(true)
    setError('')

    try {
      const response = await fetch('/api/auth/quick-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username })
      })

      const data = await response.json()

      if (data.success) {
        onLoginSuccess(data.user, data.token)

        if (data.isNewUser) {
          console.log(`✅ 新用户注册: ${data.user.displayName}`)
        } else {
          console.log(`✅ 用户登录: ${data.user.displayName}`)
        }
      } else {
        setError(data.error || '登录失败')
      }
    } catch (err) {
      setError('网络错误，请重试')
      console.error('Login error:', err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="welcome-container">
      <div className="welcome-card">
        <div className="welcome-header">
          <h1>🚀 Harness-FD</h1>
          <p>汽车功能定义工作区</p>
        </div>

        <div className="login-form">
          <label>请输入您的用户名</label>
          <input
            type="text"
            placeholder="用户名（中文/字母/数字）"
            value={username}
            onChange={e => setUsername(e.target.value)}
            onKeyPress={e => e.key === 'Enter' && !loading && handleLogin()}
            maxLength={20}
            autoFocus
            disabled={loading}
          />

          {error && <div className="error-message">{error}</div>}

          <button
            onClick={handleLogin}
            disabled={loading || !username}
          >
            {loading ? '登录中...' : '进入应用'}
          </button>

          <p className="hint">
            💡 首次使用将自动创建账号
          </p>
        </div>

        <div className="welcome-footer">
          <p>团队协作 · 知识共享 · 高效智能</p>
        </div>
      </div>
    </div>
  )
}
