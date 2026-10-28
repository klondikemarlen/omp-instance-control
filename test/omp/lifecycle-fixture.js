export function createEventBus() {
  const listeners = new Map()
  return {
    emit(channel, value) {
      for (const listener of listeners.get(channel) ?? []) listener(value)
    },
    on(channel, listener) {
      let channelListeners = listeners.get(channel)
      if (!channelListeners) {
        channelListeners = new Set()
        listeners.set(channel, channelListeners)
      }
      channelListeners.add(listener)
      return () => channelListeners.delete(listener)
    },
  }
}

export function createSdk() {
  return {
    KeybindingsManager: {
      inMemory() {
        return { matches: () => false }
      },
    },
  }
}

export function createExtensionApi(events, handlers) {
  return {
    api: {
      events,
      pi: createSdk(),
      runtime: { flagValues: new Map() },
      on(event, handler) {
        handlers.set(event, handler)
      },
      registerCommand() {},
    },
  }
}
