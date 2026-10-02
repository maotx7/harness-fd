import '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools?: any
    embeddings?: any
    attachments?: any
    sessionProjections?: any
  }
}
