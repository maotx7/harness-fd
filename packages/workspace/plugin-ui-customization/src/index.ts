import { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-host-webserver'
import { readFileSync } from 'node:fs'

export const name = 'ui-customization'

const stylesheet = readFileSync(new URL('../dist/custom-ui.css', import.meta.url), 'utf8')

export function apply(ctx: Context) {
  ctx.on('webserver/index-inject', table => {
    table.push({ kind: 'style', text: stylesheet })
  })
}
