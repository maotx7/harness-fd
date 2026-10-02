import '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools?: any
  }
}
