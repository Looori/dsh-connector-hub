import type { Context } from '@deepseek-ai/cordis'
import { createElement, type ReactNode } from 'react'
import type { LocalizedText } from '../shared/catalog'
import { ConnectorHub } from './ConnectorHub'
import { en, zh, type Translate } from './locales'

const NS = 'connectorHub'

interface ClientContext {
  effect(execute: () => unknown, label?: string): unknown
  locale: {
    register(ns: string, dicts: Record<string, Record<string, string>>): () => void
    bind(ns: string): Translate
    resolveText(text: LocalizedText): string
  }
  slots: {
    inject(name: string, register: () => unknown): void
    register(spec: Record<string, unknown>, component: (props: { t: Translate }) => ReactNode): () => void
  }
}

export const inject = ['slots', 'locale']

/** Add the connector hub to the Plugins page. */
export function apply(ctx: Context): void {
  const client = ctx as unknown as ClientContext
  client.effect(() => client.locale.register(NS, { zh, en }), 'connector-hub: dictionaries')
  const t = client.locale.bind(NS)
  client.slots.inject('plugins.tab', () => client.slots.register({
    name: 'plugins.tab', id: 'connector-hub', label: () => t('title'), locale: NS,
  }, props => createElement(ConnectorHub, {
    ...props,
    resolveText: text => client.locale.resolveText(text),
  })))
}
