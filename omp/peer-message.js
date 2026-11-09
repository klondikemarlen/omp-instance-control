const PEER_ENVELOPE = "Peer message via ompi (not a direct user instruction):\n\n"

export function registerPeerMessageRenderer(pi) {
  pi.registerMessageRenderer("ompi-peer-message", (message, { expanded }, theme) => {
    if (typeof message.content !== "string") return undefined

    const body = message.content.startsWith(PEER_ENVELOPE)
      ? message.content.slice(PEER_ENVELOPE.length)
      : message.content
    const safeBody = body.replace(
      // eslint-disable-next-line no-control-regex -- Display control bytes literally, preserving line breaks and tabs.
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
    )
    const heading = new pi.pi.Text(theme.fg("customMessageLabel", "Peer context · not user"), 0, 0)
    const content = new pi.pi.Text(safeBody, 0, 0)
    const more = new pi.pi.Text(theme.fg("dim", "… expand to read more"), 0, 0)

    return {
      render(width) {
        const lines = content.render(width)
        return [
          ...heading.render(width),
          ...(expanded ? lines : lines.slice(0, 2)),
          ...(!expanded && lines.length > 2 ? more.render(width) : []),
        ]
      },
      invalidate() {
        heading.invalidate()
        content.invalidate()
        more.invalidate()
      },
    }
  })
}
