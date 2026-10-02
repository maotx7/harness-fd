import '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools?: any
    embeddings?: any
    attachments?: any
    sessionProjections?: any
  }

  interface Events {
    'session/created'(session: any): void
    'tools/pre-execute'(event: any, next: () => any): any
  }
}
