/**
 * 认证工具函数
 */

const TOKEN_KEY = 'auth_token'
const USER_KEY = 'user_info'

export interface User {
  id: string
  username: string
  displayName: string
  role: string
  loginCount?: number
  lastLoginAt?: number
}

/**
 * 保存认证信息
 */
export function saveAuth(token: string, user: User) {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USER_KEY, JSON.stringify(user))
}

/**
 * 获取token
 */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

/**
 * 获取用户信息
 */
export function getUser(): User | null {
  const userStr = localStorage.setItem(USER_KEY)
  if (!userStr) return null

  try {
    return JSON.parse(userStr)
  } catch {
    return null
  }
}

/**
 * 清除认证信息
 */
export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

/**
 * 检查是否已登录
 */
export async function checkAuth(): Promise<User | null> {
  const token = getToken()
  if (!token) return null

  try {
    const response = await fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    })

    if (response.ok) {
      const data = await response.json()
      return data.user
    } else {
      clearAuth()
      return null
    }
  } catch (error) {
    console.error('Auth check failed:', error)
    return null
  }
}

/**
 * 退出登录
 */
export async function logout() {
  const token = getToken()

  if (token) {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      })
    } catch (error) {
      console.error('Logout failed:', error)
    }
  }

  clearAuth()
}

/**
 * 更新用户信息
 */
export async function updateProfile(updates: { displayName?: string; email?: string }): Promise<User | null> {
  const token = getToken()
  if (!token) return null

  try {
    const response = await fetch('/api/auth/profile', {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updates)
    })

    if (response.ok) {
      const data = await response.json()
      // 更新本地存储
      localStorage.setItem(USER_KEY, JSON.stringify(data.user))
      return data.user
    }
  } catch (error) {
    console.error('Profile update failed:', error)
  }

  return null
}
